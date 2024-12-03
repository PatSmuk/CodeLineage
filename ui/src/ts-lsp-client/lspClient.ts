import { once } from "events";
import { JSONRPCEndpoint } from "./jsonRpcEndpoint";
import {
  CallHierarchyItem,
  CallHierarchyPrepareParams,
  DeclarationParams,
  DefinitionParams,
  DidCloseTextDocumentParams,
  DidOpenTextDocumentParams,
  DocumentSymbol,
  DocumentSymbolParams,
  Hover,
  HoverParams,
  InitializeParams,
  InitializeResult,
  Location,
  LocationLink,
  ReferenceParams,
  ResponseError,
  ShutdownResult,
  SignatureHelp,
  SignatureHelpParams,
  SymbolInformation,
  TypeDefinitionParams,
} from "./models";

export class LspClient {
  private endpoint: JSONRPCEndpoint;

  public constructor(endpoint: JSONRPCEndpoint) {
    this.endpoint = endpoint;
  }

  public initialize(params: InitializeParams): PromiseLike<InitializeResult> {
    return this.endpoint.send("initialize", params);
  }

  public initialized(): void {
    this.endpoint.notify("initialized");
  }

  public shutdown(): PromiseLike<ShutdownResult> {
    return this.endpoint.send("shutdown");
  }

  public exit(): void {
    this.endpoint.notify("exit");
  }

  public didOpen(params: DidOpenTextDocumentParams): void {
    this.endpoint.notify("textDocument/didOpen", params);
  }

  public didClose(params: DidCloseTextDocumentParams): void {
    this.endpoint.notify("textDocument/didClose", params);
  }

  public documentSymbol(
    params: DocumentSymbolParams
  ): PromiseLike<DocumentSymbol[] | SymbolInformation[] | null> {
    return this.endpoint.send("textDocument/documentSymbol", params);
  }

  public references(
    params: ReferenceParams
  ): PromiseLike<Location[] | ResponseError | null> {
    return this.endpoint.send("textDocument/references", params);
  }

  public definition(
    params: DefinitionParams
  ): PromiseLike<
    Location | Location[] | LocationLink[] | ResponseError | null
  > {
    return this.endpoint.send("textDocument/definition", params);
  }

  public typeDefinition(
    params: TypeDefinitionParams
  ): PromiseLike<
    Location | Location[] | LocationLink[] | ResponseError | null
  > {
    return this.endpoint.send("textDocument/typeDefinition", params);
  }

  public signatureHelp(
    params: SignatureHelpParams
  ): PromiseLike<SignatureHelp | null> {
    return this.endpoint.send("textDocument/signatureHelp", params);
  }

  public once(method: string): ReturnType<typeof once> {
    return once(this.endpoint, method);
  }

  public hover(params: HoverParams): PromiseLike<Hover> {
    return this.endpoint.send("textDocument/hover", params);
  }

  public gotoDeclaration(
    params: DeclarationParams
  ): PromiseLike<Location | Location[] | LocationLink[] | null> {
    return this.endpoint.send("textDocument/declaration", params);
  }

  public prepareCallHierarchy(
    params: CallHierarchyPrepareParams
  ): PromiseLike<CallHierarchyItem[] | null> {
    return this.endpoint.send("textDocument/prepareCallHierarchy", params);
  }
}
