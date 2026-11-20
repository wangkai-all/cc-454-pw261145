/** 领域冲突错误：携带机器可读 code，HTTP 层统一映射状态码 */
export class DomainError extends Error {
  constructor(
    public code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'BLOCKED'
      | 'VALIDATION'
      | 'PRECONDITION',
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
