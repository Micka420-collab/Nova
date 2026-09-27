// Expected refusals raised by main-process services, mapped 1:1 to an IPC error code.
import type { IpcErrorCode } from "@nova/shared";

export class ServiceError extends Error {
  readonly code: IpcErrorCode;
  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}
