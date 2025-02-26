import * as path from 'path';
import { workspace, ExtensionContext, Disposable, window, OutputChannel } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;
let outputChannel: OutputChannel;

function log(message: string) {
    if (!outputChannel) {
        outputChannel = window.createOutputChannel("Swift LSP");
    }
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function activate(context: ExtensionContext) {
    log("Activating Swift LSP extension...");

    try {
        // The server is implemented in node
        const serverModule = context.asAbsolutePath(
            path.join('out', 'server.js')
        );
        log(`Server module path: ${serverModule}`);

        // Server options
        const serverOptions: ServerOptions = {
            run: {
                module: serverModule,
                transport: TransportKind.ipc,
                options: {
                    execArgv: []
                }
            },
            debug: {
                module: serverModule,
                transport: TransportKind.ipc,
                options: {
                    execArgv: ['--nolazy', '--inspect=6009']
                }
            }
        };

        // Client options
        const clientOptions: LanguageClientOptions = {
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
                provideDefinition: async (document, position, token, next) => {
                    const result = await next(document, position, token);
                    return result;
                }
            }
        };

        // Create and start the client
        client = new LanguageClient(
            'swift-lsp',
            'Swift Language Server',
            serverOptions,
            clientOptions
        );

        // Start the client
        log('Starting language client...');
        client.start();
        log('Language client started');

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