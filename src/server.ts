import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    TextDocumentSyncKind,
    InitializeResult,
    Location,
    Definition,
    TextDocumentPositionParams,
    Position,
    Logger,
    WorkspaceFolder
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

function log(message: string, type: 'info' | 'warn' | 'error' = 'info') {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] ${message}`;

    switch (type) {
        case 'warn':
            connection.console.warn(formattedMessage);
            break;
        case 'error':
            connection.console.error(formattedMessage);
            break;
        default:
            connection.console.info(formattedMessage);
    }
}

// Configure server logging
log('Swift LSP server starting...');

// Create a text document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Store symbol definitions with URI indexing for faster cleanup
interface SymbolLocation {
    uri: string;
    line: number;
    character: number;
    type: 'struct' | 'class' | 'protocol' | 'func' | 'enum' | 'extension' | 'var';
    name: string;
    context?: string;
}

// Map of URI to symbol maps for better memory management
const symbolsByUri = new Map<string, Map<string, SymbolLocation>>();
const MAX_CACHED_FILES = 50; // Reduced from 100
const CLEANUP_INTERVAL = 60 * 1000; // More frequent cleanup (1 minute)
const MAX_SYMBOLS_PER_FILE = 1000; // Limit symbols per file
const PARSE_DEBOUNCE_MS = 500; // Debounce parsing operations
const MAX_FILE_SIZE_MB = 5; // Skip files larger than 5MB

// LRU tracking for file access
const fileAccessTimes = new Map<string, number>();

// Debounce helper
function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout | null = null;
    return (...args: Parameters<T>) => {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
            timeout = null;
            func(...args);
        }, wait);
    };
}

// Memory usage tracking
let lastMemoryCheck = Date.now();
const MEMORY_CHECK_INTERVAL = 30000; // 30 seconds

function checkMemoryUsage(): boolean {
    const now = Date.now();
    if (now - lastMemoryCheck < MEMORY_CHECK_INTERVAL) {
        return true; // Skip check if too recent
    }
    lastMemoryCheck = now;

    const memoryUsage = process.memoryUsage();
    const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;

    if (heapUsedMB > 200) { // If using more than 200MB
        log(`High memory usage detected: ${Math.round(heapUsedMB)}MB. Triggering cleanup.`, 'warn');
        cleanupOldSymbols(true); // Force cleanup
        return false;
    }
    return true;
}

// Enhanced cleanup function
function cleanupOldSymbols(force: boolean = false) {
    if (!force && symbolsByUri.size <= MAX_CACHED_FILES) {
        return;
    }

    const sortedFiles = Array.from(fileAccessTimes.entries())
        .sort(([, time1], [, time2]) => time1 - time2);

    // If forced, clear more aggressively
    const targetSize = force ? Math.floor(MAX_CACHED_FILES / 2) : MAX_CACHED_FILES;

    while (symbolsByUri.size > targetSize) {
        const [oldestUri] = sortedFiles.shift() || [];
        if (oldestUri) {
            symbolsByUri.delete(oldestUri);
            fileAccessTimes.delete(oldestUri);
            log(`Cleaned up symbols for: ${path.basename(oldestUri)}`);
        }
    }

    // Force garbage collection if available
    if (force && global.gc) {
        try {
            global.gc();
            log('Forced garbage collection');
        } catch (e) {
            // Ignore if gc is not available
        }
    }
}

// Enhanced symbol storage
function getSymbolsForFile(uri: string): Map<string, SymbolLocation> {
    if (!checkMemoryUsage()) {
        // If memory usage is high, clear some space first
        cleanupOldSymbols(true);
    }

    fileAccessTimes.set(uri, Date.now());
    let fileSymbols = symbolsByUri.get(uri);
    if (!fileSymbols) {
        fileSymbols = new Map<string, SymbolLocation>();
        symbolsByUri.set(uri, fileSymbols);
    }
    return fileSymbols;
}

// Function to recursively find Swift files
function findSwiftFiles(dir: string): string[] {
    let results: string[] = [];
    try {
        const files = fs.readdirSync(dir);

        for (const file of files) {
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory() && !file.startsWith('.')) {
                    // Recursively search directories, skip hidden ones
                    results = results.concat(findSwiftFiles(fullPath));
                } else if (file.endsWith('.swift')) {
                    results.push(fullPath);
                }
            } catch (error) {
                log(`Error accessing path ${fullPath}: ${error}`, 'warn');
            }
        }
    } catch (error) {
        log(`Error reading directory ${dir}: ${error}`, 'error');
    }
    return results;
}

// Parse symbol definitions in text content with optimized memory usage
function parseSymbolsInContent(content: string, uri: string): void {
    // Skip large files
    const fileSizeMB = Buffer.byteLength(content, 'utf8') / 1024 / 1024;
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
        log(`Skipping large file ${path.basename(uri)}: ${Math.round(fileSizeMB)}MB`, 'warn');
        return;
    }

    try {
        const fileSymbols = getSymbolsForFile(uri);
        fileSymbols.clear();

        const lines = content.split('\n');
        let symbolCount = 0;
        let contextStack: { type: 'struct' | 'class' | 'protocol' | 'extension'; name: string }[] = [];

        // Process in chunks to avoid blocking
        const chunkSize = 1000;
        for (let i = 0; i < lines.length; i += chunkSize) {
            const chunk = lines.slice(i, i + chunkSize);

            for (const [lineIndex, line] of chunk.entries()) {
                const absoluteLineNumber = i + lineIndex;

                // Skip if we've hit the symbol limit
                if (symbolCount >= MAX_SYMBOLS_PER_FILE) {
                    log(`Symbol limit reached for ${path.basename(uri)}`, 'warn');
                    return;
                }

                // Process line and update symbols
                if (processLine(line, absoluteLineNumber, uri, fileSymbols, contextStack)) {
                    symbolCount++;
                }
            }

            // Check memory usage after each chunk
            if (!checkMemoryUsage()) {
                log(`Memory limit reached while processing ${path.basename(uri)}`, 'warn');
                return;
            }
        }

        if (symbolCount > 0) {
            log(`Found ${symbolCount} symbols in ${path.basename(uri)}`);
        }
    } catch (error) {
        log(`Error parsing content from ${uri}: ${error}`, 'error');
    }
}

// Define regex patterns for different symbol types
const patterns = [
    // Enhanced struct pattern to better match SwiftUI views
    {
        type: 'struct' as const,
        pattern: /(?:public\s+|private\s+|fileprivate\s+|internal\s+)?struct\s+(\w+)(?::\s*View)?(?=[\s{])/
    },
    {
        type: 'class' as const,
        pattern: /(?:public\s+|private\s+|fileprivate\s+|internal\s+)?(?:final\s+)?class\s+(\w+)(?=[\s:{])/
    },
    {
        type: 'protocol' as const,
        pattern: /(?:public\s+|private\s+|fileprivate\s+|internal\s+)?protocol\s+(\w+)(?=[\s:{])/
    },
    {
        type: 'func' as const,
        pattern: /(?:public\s+|private\s+|fileprivate\s+|internal\s+)?(?:static\s+|class\s+)?func\s+(\w+)(?=\s*[\(<])/
    },
    {
        type: 'enum' as const,
        pattern: /(?:public\s+|private\s+|fileprivate\s+|internal\s+)?enum\s+(\w+)(?=[\s:{])/
    },
    {
        type: 'extension' as const,
        pattern: /(?:public\s+|private\s+|fileprivate\s+|internal\s+)?extension\s+(\w+)(?=[\s:{])/
    },
    {
        type: 'var' as const,
        pattern: /(?:public\s+|private\s+|fileprivate\s+|internal\s+)?(?:var|let)\s+(\w+)(?=\s*:)/
    }
];

// Helper function to update context stack based on braces
function updateContextStack(
    line: string,
    contextStack: { type: 'struct' | 'class' | 'protocol' | 'extension'; name: string }[]
): void {
    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;

    // Process close braces first
    for (let i = 0; i < closeBraces; i++) {
        if (contextStack.length > 0) {
            contextStack.pop();
        }
    }

    // Look for new context definitions
    const contextMatch = line.match(/(?:struct|class|protocol|extension)\s+(\w+)/);
    if (contextMatch) {
        const type = line.match(/^[^{]*?(struct|class|protocol|extension)/)?.[1] as 'struct' | 'class' | 'protocol' | 'extension';
        if (type) {
            contextStack.push({ type, name: contextMatch[1] });
        }
    }

    // Process open braces after context updates
    for (let i = 0; i < openBraces; i++) {
        if (contextStack.length > 0) {
            contextStack.push({ ...contextStack[contextStack.length - 1] });
        }
    }
}

// Enhanced line processing logic
function processLine(
    line: string,
    lineNumber: number,
    uri: string,
    fileSymbols: Map<string, SymbolLocation>,
    contextStack: { type: 'struct' | 'class' | 'protocol' | 'extension'; name: string }[]
): boolean {
    const trimmedLine = line.trim();

    // Quick early returns for common cases
    if (!trimmedLine || trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.endsWith('*/')) {
        return false;
    }

    // Update context stack based on braces
    updateContextStack(trimmedLine, contextStack);

    // Try to match symbols
    for (const { type, pattern } of patterns) {
        // Create a copy of the line for pattern matching, preserving SwiftUI view declarations
        let lineForMatching = line;
        if (type === 'struct') {
            // Preserve View protocol conformance
            lineForMatching = line.replace(/(?<=View)[\s\S]*$/, '');
        } else {
            // For other types, we can be more aggressive in cleaning
            lineForMatching = line.replace(/"[^"]*"/g, '""').replace(/\([^)]*\)/g, '()');
        }

        const match = pattern.exec(lineForMatching);
        if (!match) continue;

        const symbolName = match[1];
        const character = match.index;

        // Skip if it's part of a comment
        const beforeMatch = line.substring(0, match.index).trim();
        if (beforeMatch.endsWith('//')) {
            continue;
        }

        // Get current context path
        const contextPath = contextStack.map(ctx => ctx.name).join('.');

        // Store symbol with additional metadata for SwiftUI views
        const key = contextPath ? `${contextPath}.${symbolName}` : symbolName;
        const isSwiftUIView = type === 'struct' && line.includes(': View');

        fileSymbols.set(key, {
            uri,
            line: lineNumber,
            character,
            type,
            name: symbolName,
            context: contextPath || undefined
        });

        // For SwiftUI views, also store without context for better lookup
        if (isSwiftUIView) {
            fileSymbols.set(symbolName, {
                uri,
                line: lineNumber,
                character,
                type,
                name: symbolName,
                context: contextPath || undefined
            });
        }

        return true;
    }

    return false;
}

// Debounced document change handler
const debouncedParseContent = debounce((document: TextDocument) => {
    parseSymbolsInContent(document.getText(), document.uri);
}, PARSE_DEBOUNCE_MS);

// Update document change handler
documents.onDidChangeContent(change => {
    const changedUri = change.document.uri;
    log(`Document changed: ${path.basename(changedUri)}`);
    debouncedParseContent(change.document);
});

// Scan workspace for symbol definitions
async function scanWorkspace(workspaceFolders: WorkspaceFolder[] | null) {
    if (!workspaceFolders) {
        log('No workspace folders found', 'warn');
        return;
    }

    for (const folder of workspaceFolders) {
        log(`Scanning workspace folder: ${folder.uri}`);
        const folderPath = folder.uri.replace('file://', '');

        try {
            const swiftFiles = findSwiftFiles(folderPath);
            log(`Found ${swiftFiles.length} Swift files in ${path.basename(folderPath)}`);

            for (const file of swiftFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const fileUri = 'file://' + file;
                    parseSymbolsInContent(content, fileUri);
                } catch (error) {
                    log(`Error reading file ${file}: ${error}`, 'error');
                }
            }
        } catch (error) {
            log(`Error scanning workspace folder ${folderPath}: ${error}`, 'error');
        }
    }

    log(`Completed workspace scan. Found ${symbolsByUri.size} total symbols`);
}

// Store workspace folders
let workspaceFolders: WorkspaceFolder[] | null = null;

// Configuration for the language server
interface ServerConfiguration {
    useSimpleMode: boolean;
}

let serverConfig: ServerConfiguration = {
    useSimpleMode: true
};

// Add configuration handler
connection.onDidChangeConfiguration(change => {
    serverConfig = (change.settings.swiftLanguageServer as ServerConfiguration) || { useSimpleMode: true };
    log(`Configuration updated. Simple mode: ${serverConfig.useSimpleMode}`);
});

// Simple symbol search function
async function findSymbolSimple(word: string): Promise<SymbolLocation | null> {
    try {
        // Simple patterns to match symbol definitions
        const simplePatterns = [
            `struct ${word}\\b`,
            `class ${word}\\b`,
            `var ${word}\\b`,
            `let ${word}\\b`,
            `func ${word}\\b`,
            `enum ${word}\\b`,
            `protocol ${word}\\b`,
            `extension ${word}\\b`
        ];

        if (!workspaceFolders) {
            log('No workspace folders available for simple search', 'warn');
            return null;
        }

        // Search in all workspace folders
        for (const folder of workspaceFolders) {
            const folderPath = folder.uri.replace('file://', '');
            const swiftFiles = findSwiftFiles(folderPath);

            for (const file of swiftFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const lines = content.split('\n');

                    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
                        const line = lines[lineNum];

                        // Skip comments
                        if (line.trim().startsWith('//')) continue;

                        for (const pattern of simplePatterns) {
                            const regex = new RegExp(pattern);
                            const match = regex.exec(line);
                            if (match) {
                                return {
                                    uri: 'file://' + file,
                                    line: lineNum,
                                    character: match.index,
                                    type: pattern.split(' ')[0] as any,
                                    name: word,
                                    context: undefined
                                };
                            }
                        }
                    }
                } catch (error) {
                    log(`Error reading file ${file}: ${error}`, 'error');
                }
            }
        }
    } catch (error) {
        log(`Error in simple symbol search: ${error}`, 'error');
    }
    return null;
}

connection.onInitialize(async (params: InitializeParams) => {
    log('Initializing Swift LSP server...');
    workspaceFolders = params.workspaceFolders || null;

    try {
        // Scan workspace for symbol definitions
        await scanWorkspace(workspaceFolders);

        const result: InitializeResult = {
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Incremental,
                definitionProvider: true
            }
        };
        return result;
    } catch (error) {
        log(`Initialization error: ${error}`, 'error');
        throw error;
    }
});

// Update the definition handler
connection.onDefinition(
    async (params: TextDocumentPositionParams): Promise<Definition | null> => {
        try {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                log('Document not found for definition request', 'warn');
                return null;
            }

            const text = document.getText();
            const position = params.position;
            const lines = text.split('\n');
            const line = lines[position.line];

            // Get the word at current position
            const wordRegex = /[A-Za-z0-9_]+/g;
            let word = '';
            let match;

            while ((match = wordRegex.exec(line)) !== null) {
                if (position.character >= match.index &&
                    position.character <= match.index + match[0].length) {
                    word = match[0];
                    break;
                }
            }

            if (!word) {
                log('No word found at cursor position', 'warn');
                return null;
            }

            log(`Looking for definition of: ${word} (Simple mode: ${serverConfig.useSimpleMode})`);

            if (serverConfig.useSimpleMode) {
                // Use simple search mode
                const symbolDef = await findSymbolSimple(word);
                if (symbolDef) {
                    log(`Found ${symbolDef.type} definition for ${word} at ${path.basename(symbolDef.uri)}:${symbolDef.line + 1}`);
                    return Location.create(
                        symbolDef.uri,
                        {
                            start: { line: symbolDef.line, character: symbolDef.character },
                            end: { line: symbolDef.line, character: symbolDef.character + word.length }
                        }
                    );
                }
            } else {
                // Use existing complex search mode
                // Find the current context by scanning backwards
                let contextStack: string[] = [];
                let contextBraceCount = 0;
                for (let i = position.line; i >= 0; i--) {
                    const currentLine = lines[i];
                    const openBraces = (currentLine.match(/{/g) || []).length;
                    const closeBraces = (currentLine.match(/}/g) || []).length;

                    // Process close braces first
                    contextBraceCount -= closeBraces;

                    // Look for context definitions
                    const contextMatch = currentLine.match(/(?:struct|class|protocol|extension)\s+(\w+)/);
                    if (contextMatch && contextBraceCount >= 0) {
                        contextStack.unshift(contextMatch[1]);
                    }

                    // Process open braces
                    contextBraceCount += openBraces;

                    // Stop if we're at root level
                    if (contextBraceCount < 0) {
                        break;
                    }
                }

                // Build context path
                const contextPath = contextStack.join('.');
                log(`Current context: ${contextPath || 'global'}`);

                // Search for symbol in all cached files
                let symbolDef: SymbolLocation | undefined;

                // First try the current file
                const currentFileSymbols = symbolsByUri.get(params.textDocument.uri);
                if (currentFileSymbols) {
                    symbolDef = contextPath ?
                        currentFileSymbols.get(`${contextPath}.${word}`) :
                        currentFileSymbols.get(word);
                }

                // If not found in current file, search other cached files
                if (!symbolDef) {
                    for (const [uri, fileSymbols] of symbolsByUri.entries()) {
                        if (uri === params.textDocument.uri) continue;

                        symbolDef = fileSymbols.get(word);
                        if (symbolDef) break;
                    }
                }

                if (symbolDef) {
                    log(`Found ${symbolDef.type} definition for ${word} at ${path.basename(symbolDef.uri)}:${symbolDef.line + 1}`);
                    return Location.create(
                        symbolDef.uri,
                        {
                            start: { line: symbolDef.line, character: symbolDef.character },
                            end: { line: symbolDef.line, character: symbolDef.character + word.length }
                        }
                    );
                }
            }

            log(`No definition found for ${word}`, 'warn');
            return null;
        } catch (error) {
            log(`Error handling definition request: ${error}`, 'error');
            return null;
        }
    }
);

// Parse all open documents initially
documents.onDidOpen(e => {
    const uri = e.document.uri;
    log(`Document opened: ${path.basename(uri)}`);
    try {
        parseSymbolsInContent(e.document.getText(), uri);
    } catch (error) {
        log(`Error parsing opened document: ${error}`, 'error');
    }
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
log('Swift LSP server is ready');
connection.listen(); 