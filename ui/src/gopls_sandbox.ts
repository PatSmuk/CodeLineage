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

const TEST_FILE_URI =
  "file:///Users/pat.smuk/Code/gitlab.indexexchange.com/exchange-node/impression/internal/service/http.go";

(async () => {
  await client.initialize({
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

  //console.log("initialize response:");
  //console.log(JSON.stringify(initializeResponse, null, 2));

  await client.initialized();

  const results = (await client.documentSymbol({
    textDocument: {
      uri: TEST_FILE_URI,
    },
  })) as SymbolInformation[] | null;

  //console.log("document symbol results:");
  //console.log(JSON.stringify(results, null, 2));

  if (!results) {
    await client.shutdown();
    return;
  }

  for (const { location, name, kind } of results) {
    if (kind === SymbolKind.Function) {
      const prepareResult = await client.prepareCallHierarchy({
        textDocument: {
          uri: TEST_FILE_URI,
        },
        position: {
          line: location.range.start.line,
          character: location.range.start.character + 5,
        },
      });

      console.log("\nprepare result: ");
      console.log(JSON.stringify(prepareResult, null, 2));

      if (!prepareResult) {
        continue;
      }

      const item = prepareResult[0];

      const incomingCallsResult = await client.incomingCalls({
        item,
      });

      console.log(`\nincoming calls result for "${name}": `);
      console.log(JSON.stringify(incomingCallsResult, null, 2));

      if (!incomingCallsResult) {
        continue;
      }

      for (const incomingCall of incomingCallsResult) {
        const incomingCallsResult = await client.incomingCalls({
          item: incomingCall.from,
        });
        console.log(`\nrecursive result for "${incomingCall.from.name}":`);
        console.log(JSON.stringify(incomingCallsResult, null, 2));

        if (!incomingCallsResult) {
          continue;
        }

        for (const incomingCall of incomingCallsResult) {
          const incomingCallsResult = await client.incomingCalls({
            item: incomingCall.from,
          });
          console.log(
            `\neven more recursive result for "${incomingCall.from.name}":`
          );
          console.log(JSON.stringify(incomingCallsResult, null, 2));
        }
      }
    }
  }

  await client.shutdown();
})().then(killLsp, killLsp);
