import * as path from 'path';
import { workspace, ExtensionContext, window, OutputChannel, commands } from 'vscode';
import * as lc from 'vscode-languageclient/node';

let client: lc.LanguageClient;
let outputChannel: OutputChannel;

function log(message: string) {
    if (!outputChannel) {
        outputChannel = window.createOutputChannel("Swift LSP");
    }
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

async function restartLanguageServer() {
    log('Restarting Swift Language Server...');
    if (client) {
        try {
            await client.stop();
            log('Language server stopped');
            await client.start();
            log('Language server restarted successfully');
            window.showInformationMessage('Swift Language Server restarted successfully');
        } catch (error) {
            log(`Error restarting language server: ${error}`);
            window.showErrorMessage('Failed to restart Swift Language Server');
        }
    } else {
        log('No language server instance found to restart');
        window.showWarningMessage('No Swift Language Server instance found to restart');
    }
}

export function activate(context: ExtensionContext) {
    log("Activating Swift LSP extension...");

    try {
        // Register the restart command
        const restartCommand = commands.registerCommand('swift-lsp.restartServer', restartLanguageServer);
        context.subscriptions.push(restartCommand);

        // The server is implemented in node
        const serverModule = context.asAbsolutePath(
            path.join('out', 'server.js')
        );
        log(`Server module path: ${serverModule}`);

        // Server options
        const serverOptions: lc.ServerOptions = {
            run: {
                module: serverModule,
                transport: lc.TransportKind.ipc,
                options: {
                    execArgv: []
                }
            },
            debug: {
                module: serverModule,
                transport: lc.TransportKind.ipc,
                options: {
                    execArgv: ['--nolazy', '--inspect=6009']
                }
            }
        };

        // Client options with dynamic capabilities
        const clientOptions: lc.LanguageClientOptions = {
            documentSelector: [{ scheme: 'file', language: 'swift' }],
            synchronize: {
                fileEvents: workspace.createFileSystemWatcher('**/*.swift')
            },
            outputChannel,
            traceOutputChannel: outputChannel,
            middleware: {
                handleDiagnostics: (uri, diagnostics, next) => {
                    next(uri, diagnostics);
                },
                provideReferences: async (document, position, context, token, next) => {
                    log(`Client middleware: Requesting references at ${position.line}:${position.character}`);
                    const result = await next(document, position, context, token);
                    log(`Client middleware: Got ${result?.length || 0} references`);
                    return result;
                }
            }
        };

        // Create and start the client
        client = new lc.LanguageClient(
            'swift-lsp',
            'Swift Language Server',
            serverOptions,
            clientOptions
        );

        // Start the client and wait for it to be ready
        log('Starting language client...');
        client.start().then(() => {
            log('Language client is ready');
            // Register for dynamic capability registration
            client.onRequest('client/registerCapability', async (params: lc.RegistrationParams) => {
                log(`Received capability registration request: ${JSON.stringify(params)}`);
                return null;
            });
        }).catch((error: Error) => {
            log(`Error in client initialization: ${error.message}`);
        });

        // Push the client and output channel to subscriptions
        context.subscriptions.push(client);
        if (outputChannel) {
            context.subscriptions.push(outputChannel);
        }

    } catch (error) {
        log(`Error during activation: ${error}`);
        throw error;
    }
}

export function deactivate(): Thenable<void> | undefined {
    log('Deactivating Swift LSP extension');
    if (!client) {
        return undefined;
    }
    return client.stop();
} 