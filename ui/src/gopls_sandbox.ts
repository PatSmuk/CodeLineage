import { spawn } from "child_process";
import {
  JSONRPCEndpoint,
  LspClient,
  SymbolInformation,
  SymbolKind,
} from "./ts-lsp-client";

const lspProcess = spawn("gopls", {
  shell: true,
  stdio: "pipe",
});
const killLsp = () => void lspProcess.kill();

const endpoint = new JSONRPCEndpoint(lspProcess.stdin, lspProcess.stdout);
const client = new LspClient(endpoint);

(async () => {
  const initializeResponse = await client.initialize({
    processId: process.pid,
    capabilities: {},
    clientInfo: {
      name: "gopls_test",
      version: "0.0.0",
    },
    workspaceFolders: [
      {
        uri: "file:///Users/pat.smuk/Code/gitlab.indexexchange.com/exchange-node/impression",
        name: "impression",
      },
    ],
    rootPath:
      "/Users/pat.smuk/Code/gitlab.indexexchange.com/exchange-node/impression",
    rootUri:
      "file:///Users/pat.smuk/Code/gitlab.indexexchange.com/exchange-node/impression",
  });

  console.log("initialize response:");
  console.log(JSON.stringify(initializeResponse, null, 2));

  await client.initialized();

  const results = (await client.documentSymbol({
    textDocument: {
      uri: "file:///Users/pat.smuk/Code/gitlab.indexexchange.com/exchange-node/impression/cmd/impression/impression.go",
    },
  })) as SymbolInformation[] | null;

  console.log("document symbol results:");
  console.log(JSON.stringify(results, null, 2));

  if (!results) {
    await client.shutdown();
    return;
  }

  for (const { location, name, kind } of results) {
    if (kind === SymbolKind.Function) {
    }
  }

  await client.shutdown();
})().then(killLsp, killLsp);
