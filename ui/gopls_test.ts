import { spawn } from "child_process";
import * as lspClient from "ts-lsp-client";

const lspProcess = spawn("gopls", {
  shell: true,
  stdio: "pipe",
});
const killLsp = () => void lspProcess.kill();

const endpoint = new lspClient.JSONRPCEndpoint(
  lspProcess.stdin,
  lspProcess.stdout
);
const client = new lspClient.LspClient(endpoint);

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

  const referencesResult = await client.references({
    textDocument: {
      uri: "file:///Users/pat.smuk/Code/gitlab.indexexchange.com/exchange-node/impression/cmd/impression/impression.go",
    },
    position: { line: 97, character: 14 },
    context: { includeDeclaration: false },
  });

  console.log("references result:");
  console.log(JSON.stringify(referencesResult, null, 2));

  await client.shutdown();
})().then(killLsp, killLsp);
