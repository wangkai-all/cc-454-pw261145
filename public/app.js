// 来源字段映射管理平台 —— 前端单页应用（原生 ESM）
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  sources: [],
  currentSourceId: null,
  changes: [],
  versions: [],
  batches: [],
};

// ---------- 基础工具 ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function modal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  $('.modal-backdrop', root).addEventListener('click', (e) => {
    if (e.target === e.currentTarget) root.innerHTML = '';
  });
  return root;
}
const closeModal = () => ($('#modal-root').innerHTML = '');

function statusTag(status) {
  const label = { pending: '待审批', approved: '已批准', scheduled: '待生效', published: '已发布', rejected: '已驳回' }[status] ?? status;
  return `<span class="tag status-${status}">${label}</span>`;
}
function levelTag(level) {
  const label = { safe: '安全', blocked: '阻断', compatible: '兼容' }[level] ?? level;
  return `<span class="tag ${level}">${label}</span>`;
}

// ---------- 数据加载 ----------
async function loadAll() {
  state.sources = await api('/api/sources');
  if (!state.currentSourceId && state.sources[0]) state.currentSourceId = state.sources[0].id;
  await refreshCurrent();
}

async function refreshCurrent() {
  renderSources();
  if (!state.currentSourceId) {
    $('#change-list').innerHTML = '<div class="empty">请先创建或选择一个数据来源</div>';
    $('#version-timeline').innerHTML = '';
    $('#batch-list').innerHTML = '';
    return;
  }
  const [changes, versions, batches] = await Promise.all([
    api(`/api/changes?sourceId=${encodeURIComponent(state.currentSourceId)}`),
    api(`/api/sources/${encodeURIComponent(state.currentSourceId)}/versions`),
    api('/api/batches'),
  ]);
  state.changes = changes;
  state.versions = versions;
  state.batches = batches;
  renderChanges();
  renderVersions();
  renderBatches();
}

// ---------- 来源 ----------
function renderSources() {
  $('#source-list').innerHTML = state.sources
    .map(
      (s) => `
      <div class="source-item ${s.id === state.currentSourceId ? 'active' : ''}" data-id="${esc(s.id)}">
        <div class="sid">${esc(s.id)}</div>
        <div class="sname">${esc(s.name)}</div>
      </div>`,
    )
    .join('');
  $$('.source-item').forEach((el) =>
    el.addEventListener('click', async () => {
      state.currentSourceId = el.dataset.id;
      await refreshCurrent();
    }),
  );
}

$('#btn-add-source').addEventListener('click', () => {
  modal(`
    <h3>新增数据来源</h3>
    <div class="field"><label>来源 ID（英文标识）</label><input id="m-sid" placeholder="crm_main" /></div>
    <div class="field"><label>名称</label><input id="m-sname" placeholder="CRM 主库" /></div>
    <div class="field"><label>描述</label><input id="m-sdesc" /></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn primary" id="m-ok">创建</button>
    </div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    try {
      const s = await api('/api/sources', {
        method: 'POST',
        body: { id: $('#m-sid').value.trim(), name: $('#m-sname').value.trim(), description: $('#m-sdesc').value },
      });
      state.currentSourceId = s.id;
      closeModal();
      toast(`来源 ${s.id} 已创建`, 'success');
      await loadAll();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
});

// ---------- 采集器发现 ----------
$('#btn-discovery').addEventListener('click', () => {
  if (!state.currentSourceId) return toast('请先选择来源', 'error');
  const demo = JSON.stringify(
    [
      { sourceField: 'customer_tier', type: 'string', enumValues: ['vip', 'normal'] },
      { sourceField: 'login_count', type: 'integer' },
    ],
    null,
    2,
  );
  modal(`
    <h3>采集器字段上报</h3>
    <p class="hint">上报观测到的字段（JSON 数组）。新字段生成 add，类型变化生成 type_change，枚举扩展生成 enum_update，消失字段生成阻断态 remove。</p>
    <div class="field"><textarea id="m-fields" rows="10">${esc(demo)}</textarea></div>
    <div class="field"><label>需要审批人数</label><input id="m-approvals" type="number" value="2" min="1" /></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn primary" id="m-ok">生成变更单</button>
    </div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    try {
      const observed = JSON.parse($('#m-fields').value);
      const r = await api(`/api/sources/${encodeURIComponent(state.currentSourceId)}/discovery`, {
        method: 'POST',
        body: { observed, requiredApprovals: Number($('#m-approvals').value) },
      });
      closeModal();
      toast(r.deduped ? '相同变更已存在，返回原变更单（幂等去重）' : `变更单 ${r.proposal.id} 已生成`, r.deduped ? '' : 'success');
      await refreshCurrent();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
});

// ---------- 变更单 ----------
function renderChanges() {
  if (state.changes.length === 0) {
    $('#change-list').innerHTML = '<div class="empty">暂无变更单。通过左侧“上报字段发现”或手工创建生成。</div>';
    return;
  }
  $('#change-list').innerHTML = state.changes.map(renderChangeCard).join('');
  bindChangeEvents();
}

function renderChangeCard(c) {
  const approvers = c.approvals.map(
    (a) => `<span class="avatar ${a.decision === 'approve' ? 'approved' : 'rejected'}" title="${esc(a.comment ?? '')}">${esc(a.approver.slice(0, 2))}</span>`,
  );
  const ops = c.ops
    .map(
      (op, i) => `
      <div class="op-row">
        <div class="op-head">
          ${levelTag(op.analysis.level)}
          <strong class="mono">${esc(op.kind)}</strong>
          <span class="mono">${esc(op.sourceField)}</span>
          ${op.type ? `<span class="meta">type: ${esc(op.type)}</span>` : ''}
          ${op.enumValues ? `<span class="meta">enum: [${op.enumValues.map(esc).join(', ')}]</span>` : ''}
          ${c.status === 'pending' && op.analysis.level === 'blocked' ? `
            <label class="meta" style="display:flex;align-items:center;gap:4px">
              <input type="checkbox" class="compat-toggle" data-idx="${i}" ${op.compatMode ? 'checked' : ''} />
              兼容模式
            </label>` : ''}
          ${op.analysis.compatStrategy ? `<span class="meta">策略: ${esc(op.analysis.compatStrategy)}</span>` : ''}
        </div>
        <ul class="op-reasons">${op.analysis.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>`,
    )
    .join('');

  const blocked = c.ops.some((o) => o.analysis.level === 'blocked');
  const actions =
    c.status === 'pending'
      ? `
        <div class="approval-bar">
          <input class="approver-input" placeholder="审批人" style="width:120px" />
          <button class="btn primary act-approve" ${blocked ? 'disabled title="存在阻断操作，请先开启兼容模式或驳回"' : ''}>审批通过</button>
          <button class="btn danger act-reject">驳回</button>
          <span class="meta">已获 ${c.approvals.filter((a) => a.decision === 'approve').length}/${c.requiredApprovals} 票</span>
          <div class="approvers">${approvers.join('')}</div>
        </div>`
      : `<div class="approval-bar">${statusTag(c.status)}<div class="approvers">${approvers.join('')}</div>
          ${c.publishedVersion ? `<span class="meta">发布为 v${c.publishedVersion} · 批次 <span class="mono">${esc(c.publishedBatchId)}</span></span>` : ''}
          ${c.rejectReason ? `<span class="meta">驳回原因：${esc(c.rejectReason)}</span>` : ''}
        </div>`;

  return `
    <div class="card" data-id="${esc(c.id)}">
      <div class="card-title">
        <strong>${esc(c.title)}</strong>
        ${statusTag(c.status)}
        <span class="meta mono">${esc(c.id)}</span>
        <span class="meta">基于 v${c.baseVersion} · 创建于 ${fmtTime(c.createdAt)} · 来源 ${esc(c.sourceId)}</span>
        ${c.effectiveAt ? `<span class="meta">计划生效 ${fmtTime(c.effectiveAt)}</span>` : ''}
      </div>
      ${ops}
      ${actions}
    </div>`;
}

function bindChangeEvents() {
  $$('.compat-toggle').forEach((cb) =>
    cb.addEventListener('change', async (e) => {
      const card = e.target.closest('.card');
      try {
        await api(`/api/changes/${card.dataset.id}/compat`, {
          method: 'POST',
          body: { opIndex: Number(e.target.dataset.idx), compatMode: e.target.checked },
        });
        toast('兼容模式已切换并重新分析', 'success');
        await refreshCurrent();
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
  );
  $$('.act-approve').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const approver = $('.approver-input', card).value.trim();
      if (!approver) return toast('请输入审批人', 'error');
      try {
        const r = await api(`/api/changes/${card.dataset.id}/approve`, { method: 'POST', body: { approver } });
        toast(r.status === 'published' ? `审批通过并已发布为 v${r.publishedVersion}` : r.status === 'scheduled' ? '审批完成，等待生效时间' : '投票已记录', 'success');
        await refreshCurrent();
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
  );
  $$('.act-reject').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const approver = $('.approver-input', card).value.trim();
      if (!approver) return toast('请输入审批人', 'error');
      const reason = prompt('驳回原因（可选）') ?? undefined;
      try {
        await api(`/api/changes/${card.dataset.id}/reject`, { method: 'POST', body: { approver, reason } });
        toast('变更单已驳回', 'success');
        await refreshCurrent();
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
  );
}

// ---------- 版本时间轴 + 差异 ----------
function renderVersions() {
  if (state.versions.length === 0) {
    $('#version-timeline').innerHTML = '<div class="empty">该来源尚无已发布版本</div>';
    return;
  }
  $('#version-timeline').innerHTML = `<div class="timeline">${state.versions
    .map(
      (v) => `
      <div class="v-node ${v.rolledBackFromVersion ? 'rollback' : ''}">
        <div class="card">
          <div class="card-title">
            <strong>v${v.version}</strong>
            ${v.rolledBackFromVersion ? `<span class="tag compatible">回滚快照（源自 v${v.rolledBackFromVersion}）</span>` : ''}
            <span class="meta">生效 ${fmtTime(v.effectiveAt)}</span>
            <span class="meta mono">批次 ${esc(v.batchId)}</span>
          </div>
          <p class="meta">${esc(v.note)}</p>
          <table>
            <thead><tr><th>来源字段</th><th>标准名</th><th>类型</th><th>必填</th><th>枚举</th><th>状态</th></tr></thead>
            <tbody>
              ${v.fields
                .map(
                  (f) => `<tr>
                    <td class="mono">${esc(f.sourceField)}</td>
                    <td class="mono">${esc(f.canonicalName)}</td>
                    <td>${esc(f.type)}${f.coercion ? ` <span class="meta">(${esc(f.coercion.strategy)})</span>` : ''}</td>
                    <td>${f.required ? '是' : '否'}</td>
                    <td>${f.enumValues.length ? esc(f.enumValues.join(', ')) : '—'}</td>
                    <td>${f.deprecated ? '<span class="tag compatible">已弃用</span>' : '<span class="tag safe">在用</span>'}</td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`,
    )
    .join('')}</div>`;
  const max = state.versions.at(-1).version;
  $('#diff-from').value = Math.max(1, max - 1);
  $('#diff-to').value = max;
}

$('#btn-diff').addEventListener('click', async () => {
  const from = Number($('#diff-from').value);
  const to = Number($('#diff-to').value);
  try {
    const d = await api(`/api/sources/${encodeURIComponent(state.currentSourceId)}/diff?from=${from}&to=${to}`);
    $('#diff-output').innerHTML = `
      <div class="card">
        <div class="card-title"><strong>v${from} → v${to} 字段差异</strong></div>
        <div class="diff-section">
          <h4 class="diff-add">新增（${d.added.length}）</h4>
          ${d.added.length ? `<ul>${d.added.map((f) => `<li class="mono">${esc(f.sourceField)}: ${esc(f.type)}</li>`).join('')}</ul>` : '<p class="meta">无</p>'}
          <h4 class="diff-remove">删除（${d.removed.length}）</h4>
          ${d.removed.length ? `<ul>${d.removed.map((f) => `<li class="mono">${esc(f.sourceField)}</li>`).join('')}</ul>` : '<p class="meta">无</p>'}
          <h4 class="diff-change">变化（${d.changed.length}）</h4>
          ${
            d.changed.length
              ? `<table><thead><tr><th>字段</th><th>v${from}</th><th>v${to}</th></tr></thead><tbody>
                ${d.changed
                  .map(
                    ({ before, after }) => `<tr>
                      <td class="mono">${esc(before.sourceField)}</td>
                      <td class="meta">${esc(JSON.stringify({ type: before.type, enum: before.enumValues, deprecated: before.deprecated }))}</td>
                      <td>${esc(JSON.stringify({ type: after.type, enum: after.enumValues, deprecated: after.deprecated }))}</td>
                    </tr>`,
                  )
                  .join('')}</tbody></table>`
              : '<p class="meta">无</p>'
          }
        </div>
      </div>`;
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ---------- 生效批次 + 回滚入口 ----------
function renderBatches() {
  const mine = state.batches.filter((b) => b.entries.some((e) => e.sourceId === state.currentSourceId));
  if (mine.length === 0) {
    $('#batch-list').innerHTML = '<div class="empty">暂无批次</div>';
    return;
  }
  const versionNums = state.versions.map((v) => v.version);
  $('#batch-list').innerHTML = mine
    .map(
      (b) => `
      <div class="card">
        <div class="card-title">
          <strong class="mono">${esc(b.id)}</strong>
          <span class="meta">${fmtTime(b.createdAt)} · 操作人 ${esc(b.createdBy)}</span>
        </div>
        <p class="meta">${esc(b.note)}</p>
        <table>
          <thead><tr><th>来源</th><th>变更单</th><th>版本</th><th>生效时间</th><th>操作</th></tr></thead>
          <tbody>
            ${b.entries
              .map(
                (e) => `<tr>
                  <td class="mono">${esc(e.sourceId)}</td>
                  <td class="mono">${e.changeId ? esc(e.changeId) : '—'}</td>
                  <td>v${e.version}</td>
                  <td>${fmtTime(e.effectiveAt)}</td>
                  <td>${
                    e.sourceId === state.currentSourceId && versionNums.length > 1
                      ? `<button class="btn small danger act-rollback" data-v="${e.version - 1}">回滚到 v${e.version - 1}</button>`
                      : ''
                  }</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`,
    )
    .join('');
  $$('.act-rollback').forEach((btn) =>
    btn.addEventListener('click', () => {
      const toVersion = Number(btn.dataset.v);
      if (toVersion < 1) return;
      const actor = prompt(`确认回滚：将追加一个等同于 v${toVersion} 字段快照的新版本（历史版本不会被改写）。请输入操作人：`);
      if (!actor) return;
      modalRollback(toVersion, actor);
    }),
  );
}

function modalRollback(toVersion, actor) {
  modal(`
    <h3>回滚确认</h3>
    <dl class="kv">
      <dt>来源</dt><dd class="mono">${esc(state.currentSourceId)}</dd>
      <dt>目标快照</dt><dd>v${toVersion}</dd>
      <dt>实现方式</dt><dd>追加新版本，版本链与历史重放时间轴保持不变</dd>
    </dl>
    <div class="field"><label>备注</label><input id="m-rb-note" placeholder="回滚原因" /></div>
    <div class="modal-actions">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn danger" id="m-ok">确认回滚</button>
    </div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    try {
      const r = await api(`/api/sources/${encodeURIComponent(state.currentSourceId)}/rollback`, {
        method: 'POST',
        body: { toVersion, actor, note: $('#m-rb-note').value },
      });
      closeModal();
      toast(`已生成回滚版本 v${r.version.version}`, 'success');
      await refreshCurrent();
      switchTab('versions');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

// ---------- 历史重放 ----------
$('#btn-replay').addEventListener('click', async () => {
  if (!state.currentSourceId) return toast('请先选择来源', 'error');
  const atRaw = $('#replay-at').value;
  if (!atRaw) return toast('请选择重放时间点', 'error');
  let records;
  try {
    records = JSON.parse($('#replay-records').value);
  } catch {
    return toast('记录 JSON 解析失败', 'error');
  }
  try {
    const r = await api(`/api/sources/${encodeURIComponent(state.currentSourceId)}/replay`, {
      method: 'POST',
      body: { records, at: new Date(atRaw).getTime() },
    });
    $('#replay-output').innerHTML = `
      <div class="card">
        <div class="card-title">
          <strong>重放结果</strong>
          <span class="tag safe">使用 v${r.usedVersion}</span>
          ${r.fallback ? '<span class="tag blocked">早于首个版本，回退首版</span>' : ''}
          <span class="meta">该版本生效于 ${fmtTime(r.effectiveAt)}</span>
        </div>
        <h4>映射输出（${r.mapped.length} 条）</h4>
        <div class="code-block">${esc(JSON.stringify(r.mapped, null, 2))}</div>
        <h4>死信队列（${r.deadLetters.length} 条）</h4>
        <div class="code-block ${r.deadLetters.length ? 'dead-letter' : ''}">${esc(
          r.deadLetters.length ? JSON.stringify(r.deadLetters, null, 2) : '无',
        )}</div>
      </div>`;
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ---------- Tab 切换 ----------
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ---------- 演示数据 ----------
$('#btn-seed').addEventListener('click', async () => {
  try {
    const sid = `demo_${Date.now().toString(36)}`;
    await api('/api/sources', { method: 'POST', body: { id: sid, name: '演示来源' } });
    state.currentSourceId = sid;
    // v1：两个基础字段，1 人审批快速发布
    let r = await api(`/api/sources/${sid}/discovery`, {
      method: 'POST',
      body: {
        observed: [
          { sourceField: 'order_id', type: 'string' },
          { sourceField: 'amount', type: 'number' },
          { sourceField: 'status', type: 'string', enumValues: ['paid', 'pending'] },
        ],
        requiredApprovals: 1,
      },
    });
    await api(`/api/changes/${r.proposal.id}/approve`, { method: 'POST', body: { approver: 'alice' } });
    // v2：含阻断项的变更（amount 缩窄 + status 枚举收缩）
    r = await api(`/api/sources/${sid}/proposals`, {
      method: 'POST',
      body: {
        title: '风险变更：amount 缩窄为整数 + status 枚举收缩',
        ops: [
          { kind: 'type_change', sourceField: 'amount', type: 'integer' },
          { kind: 'enum_update', sourceField: 'status', enumValues: ['paid'] },
        ],
        requiredApprovals: 2,
      },
    });
    await loadAll();
    toast('演示数据已载入：查看“变更与审批”中的阻断单，可切换兼容模式后双审批', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#btn-refresh').addEventListener('click', () => loadAll().then(() => toast('已刷新', 'success')).catch((e) => toast(e.message, 'error')));

loadAll().catch((e) => toast(`初始化失败：${e.message}`, 'error'));
