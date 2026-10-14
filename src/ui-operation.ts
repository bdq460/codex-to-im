import { HttpRequestError } from './ui-http-security.js';
export type BridgeOperation = 'start' | 'stop' | 'restart';
/** One operation across all clients, with a visible transitional state. */
export class BridgeOperationController {
  current: BridgeOperation | null = null;
  async run<T>(action: BridgeOperation, perform: () => Promise<T>): Promise<T> {
    if (this.current) throw new HttpRequestError(409, '已有运行操作正在进行，请等待完成。');
    this.current = action;
    try { return await perform(); } finally { this.current = null; }
  }
}
