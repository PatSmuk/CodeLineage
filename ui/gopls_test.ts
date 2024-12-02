import { spawn } from "child_process";
import { join } from "path";

interface Reference {
  file: string;
  line: number;
  column: number;
}

class GoplsReferencefinder {
  private goplsProcess: any;
  private requestId: number;

  constructor(private projectRoot: string) {
    this.requestId = 1;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Start gopls language server
      this.goplsProcess = spawn("gopls", [], {
        cwd: this.projectRoot,
        stdio: "pipe",
      });

      // Initialize gopls with the Language Server Protocol (LSP)
      const initializeRequest = {
        jsonrpc: "2.0",
        id: this.requestId++,
        method: "initialize",
        params: {
          processId: process.pid,
          rootPath: this.projectRoot,
          capabilities: {},
        },
      };

      this.goplsProcess.stdin.write(
        `Content-Length: ${JSON.stringify(initializeRequest).length}\r\n\r\n` +
          `${JSON.stringify(initializeRequest)}`
      );

      // Listen for the initialize response
      this.goplsProcess.stdout.on("data", (data: Buffer) => {
        const response = this.parseResponse(data.toString());
        if (response && response.id === 1) {
          const initializeRequest = {
            jsonrpc: "2.0",
            id: this.requestId++,
            method: "initialized",
            params: {},
          };

          this.goplsProcess.stdin.write(
            `Content-Length: ${
              JSON.stringify(initializeRequest).length
            }\r\n\r\n` + `${JSON.stringify(initializeRequest)}`
          );
        } else if (response && response.id === 2) {
          resolve();
        }
      });

      this.goplsProcess.on("error", reject);
    });
  }

  async findReferences(
    file: string,
    functionName: string
  ): Promise<Reference[]> {
    return new Promise((resolve, reject) => {
      const requestId = this.requestId++;
      const referencesRequest = {
        jsonrpc: "2.0",
        id: requestId,
        method: "textDocument/references",
        params: {
          textDocument: { uri: `file://${join(this.projectRoot, file)}` },
          position: this.findFunctionPosition(file, functionName),
          context: { includeDeclaration: true },
        },
      };

      const requestString = JSON.stringify(referencesRequest);
      this.goplsProcess.stdin.write(
        `Content-Length: ${requestString.length}\r\n\r\n${requestString}`
      );

      // Collect references
      const referenceCollector = (data: Buffer) => {
        console.log(data.toString());
        const response = this.parseResponse(data.toString());
        if (response && response.id === requestId && response.result) {
          const references: Reference[] = response.result.map((ref: any) => ({
            file: ref.uri.replace("file://", ""),
            line: ref.range.start.line + 1,
            column: ref.range.start.character + 1,
          }));
          this.goplsProcess.stdout.removeListener("data", referenceCollector);
          resolve(references);
        }
      };

      this.goplsProcess.stdout.on("data", referenceCollector);
    });
  }

  private findFunctionPosition(file: string, functionName: string): any {
    // Note: This is a placeholder. In a real implementation,
    // you'd parse the Go file to find the exact position of the function definition.
    return {
      line: 0,
      character: 0,
    };
  }

  private parseResponse(rawData: string): any {
    try {
      // Extract JSON payload from LSP message
      const contentLengthMatch = rawData.match(/Content-Length: (\d+)/);
      if (contentLengthMatch) {
        const contentLength = parseInt(contentLengthMatch[1], 10);
        const jsonStart = rawData.indexOf("{");
        const jsonPayload = rawData.substr(jsonStart, contentLength);
        return JSON.parse(jsonPayload);
      }
    } catch (error) {
      console.error("Error parsing gopls response:", error);
    }
    return null;
  }

  async close(): Promise<void> {
    // Send shutdown and exit notifications
    const shutdownRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "shutdown",
    };

    const exitNotification = {
      jsonrpc: "2.0",
      method: "exit",
    };

    this.goplsProcess.stdin.write(
      `Content-Length: ${JSON.stringify(shutdownRequest).length}\r\n\r\n` +
        `${JSON.stringify(shutdownRequest)}`
    );

    this.goplsProcess.stdin.write(
      `Content-Length: ${JSON.stringify(exitNotification).length}\r\n\r\n` +
        `${JSON.stringify(exitNotification)}`
    );

    this.goplsProcess.kill();
  }
}

// Example usage
async function findGoReferences() {
  const projectRoot =
    "/Users/pat.smuk/Code/gitlab.indexexchange.com/exchange-node/impression";
  const gopls = new GoplsReferencefinder(projectRoot);

  try {
    await gopls.start();
    const references = await gopls.findReferences(
      "cmd/impression/impression.go",
      "recordVersionMetric"
    );
    console.log("References:", references);
  } catch (error) {
    console.error("Error finding references:", error);
  } finally {
    await gopls.close();
  }
}

findGoReferences();

export default GoplsReferencefinder;
