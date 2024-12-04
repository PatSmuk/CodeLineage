import { JSONRPCClient, JSONRPCRequest, JSONRPCResponse } from "json-rpc-2.0";
import { JSONRPCParams } from "json-rpc-2.0/dist/models";
import { EventEmitter, Readable, TransformOptions, Writable } from "stream";
import { JSONRPCTransform } from "./jsonRpcTransform";

export class JSONRPCEndpoint extends EventEmitter {
  private writable: Writable;
  private readable: Readable;
  private readableByline: JSONRPCTransform;
  private client: JSONRPCClient;
  private nextId: number;

  public constructor(
    writable: Writable,
    readable: Readable,
    options?: ConstructorParameters<typeof EventEmitter>[0] & TransformOptions
  ) {
    super(options);
    this.nextId = 0;
    const createId = () => this.nextId++;
    this.writable = writable;
    this.readable = readable;
    this.readableByline = JSONRPCTransform.createStream(this.readable, options);

    this.client = new JSONRPCClient(async (jsonRPCRequest) => {
      const jsonRPCRequestStr = JSON.stringify(jsonRPCRequest);
      const contentLength = Buffer.from(jsonRPCRequestStr, "utf-8").byteLength;
      this.writable.write(
        `Content-Length: ${contentLength}\r\n\r\n${jsonRPCRequestStr}`
      );
    }, createId);

    this.readableByline.on("data", (jsonRPCResponseOrRequest: string) => {
      const jsonrpc = JSON.parse(jsonRPCResponseOrRequest);

      if (Object.prototype.hasOwnProperty.call(jsonrpc, "id")) {
        const jsonRPCResponse: JSONRPCResponse = jsonrpc as JSONRPCResponse;
        this.client.receive(jsonRPCResponse);
      } else {
        const jsonRPCRequest: JSONRPCRequest = jsonrpc as JSONRPCRequest;
        this.emit(jsonRPCRequest.method, jsonRPCRequest.params);
      }
    });
  }

  public send(
    method: string,
    message?: JSONRPCParams
  ): ReturnType<JSONRPCClient["request"]> {
    return this.client.request(method, message);
  }

  public notify(method: string, message?: JSONRPCParams): void {
    this.client.notify(method, message);
  }
}
