/// <reference path="../node_modules/typescript/lib/lib.es6.d.ts"/>

'use strict';

import vinyl = require('vinyl');
import * as through from 'through';
import {createTypeScriptBuilder, IConfiguration, CancellationToken} from './builder';
import * as ts from 'typescript';
import {Stream, Transform} from 'stream';
import {readFileSync, existsSync, readdirSync} from 'fs';
import {extname, dirname, resolve} from 'path';

declare module "through" {
    interface ThroughStream {
        queue(data: any): void;
    }
}

// We actually only want to read the tsconfig.json file. So all methods
// to read the FS are 'empty' implementations.
const _parseConfigHost = {
    useCaseSensitiveFileNames: false,
    fileExists(fileName: string): boolean {
        return existsSync(fileName);
    },
    readDirectory(rootDir: string, extensions: string[], excludes: string[], includes: string[]): string[] {
        return []; // don't want to find files!
    },
    readFile(fileName: string): string {
        return readFileSync(fileName, 'utf-8');
    },
};

export interface IncrementalCompiler {
    (): Transform;
    program?: ts.Program;
}

export type CompilerOptions = {
    [P in keyof ts.CompilerOptions]: ts.CompilerOptionsValue;
};

export type CreateOptions = {
    /** Indicates whether to report compiler diagnostics as JSON instead of as a string. */
    json?: boolean;
    /** Indicates whether to report verbose compilation messages. */
    verbose?: boolean;
    /** Provides an explicit instance of the typescript compiler to use. */
    typescript?: typeof ts;
    /** Custom callback used to report compiler diagnostics. */
    onError?: (message: any) => void;
};

/**
 * Create an IncrementalCompiler from a tsconfig.json file.
 *
 * @param project The path to a tsconfig.json file or its parent directory.
 * @param createOptions Options to pass on to the IncrementalCompiler.
 */
export function create(project: string, createOptions?: CreateOptions): IncrementalCompiler;

/**
 * Create an IncrementalCompiler from a tsconfig.json file.
 *
 * @param project The path to a tsconfig.json file or its parent directory.
 * @param verbose Indicates whether to report verbose compilation messages.
 * @param json Indicates whether to report compiler diagnostics as JSON instead of as a string.
 * @param onError Custom callback used to report compiler diagnostics.
 */
export function create(project: string, verbose?: boolean, json?: boolean, onError?: (message: any) => void): IncrementalCompiler;

/**
 * Create an IncrementalCompiler from a set of options.
 *
 * @param compilerOptions Options to pass on to the TypeScript compiler.
 * @param createOptions Options to pass on to the IncrementalCompiler.
 */
export function create(compilerOptions: CompilerOptions, createOptions?: CreateOptions): IncrementalCompiler;

/**
 * Create an IncrementalCompiler from a set of options.
 *
 * @param compilerOptions Options to pass on to the TypeScript compiler.
 * @param verbose Indicates whether to report verbose compilation messages.
 * @param json Indicates whether to report compiler diagnostics as JSON instead of as a string.
 * @param onError Custom callback used to report compiler diagnostics.
 */
export function create(compilerOptions: CompilerOptions, verbose?: boolean, json?: boolean, onError?: (message: any) => void): IncrementalCompiler;

export function create(projectOrCompilerOptions: CompilerOptions | string, verboseOrCreateOptions?: boolean | CreateOptions, json?: boolean, onError?: (message: any) => void): IncrementalCompiler {
    let verbose: boolean;
    let typescript: typeof ts;
    let base: string;
    if (typeof verboseOrCreateOptions === 'boolean') {
        verbose = verboseOrCreateOptions;
    }
    else if (verboseOrCreateOptions) {
        verbose = verboseOrCreateOptions.verbose;
        json = verboseOrCreateOptions.json;
        onError = verboseOrCreateOptions.onError;
        typescript = verboseOrCreateOptions.typescript;
    }

    if (!typescript) typescript = ts;

    let project: string | undefined;
    let projectJson: any;
    let projectDiagnostic: ts.Diagnostic | undefined;
    if (typeof projectOrCompilerOptions === 'string') {
        project = resolveProject(projectOrCompilerOptions);
        const parsed = typescript.readConfigFile(project, typescript.sys.readFile);
        if (parsed.error) {
            console.error(parsed.error);
            projectDiagnostic = parsed.error;
        }
        else {
            projectJson = parsed.config;
        }
    }
    else {
        projectJson = {
            compilerOptions: projectOrCompilerOptions || typescript.getDefaultCompilerOptions()
        };
    }

    if (!onError) onError = err => console.log(JSON.stringify(err, null, 4));

    const options = typescript.parseJsonConfigFileContent(projectJson, _parseConfigHost, project ? dirname(project) : './').options;
    const config = { json, verbose, noFilesystemLookup: false, typescript };
    const builder = createTypeScriptBuilder(config, options);
    const compiler = <IncrementalCompiler>((token?: CancellationToken): Transform => {
        if (projectDiagnostic) {
            return null;
        }

        return through(function (this: through.ThroughStream, file: vinyl) {
            // give the file to the compiler
            if (file.isStream()) {
                this.emit('error', 'no support for streams');
                return;
            }
            builder.file(file);
        }, function (this: through.ThroughStream) {
            // start the compilation process
            builder.build(file => this.queue(file), onError, token).then(() => this.queue(null));
        });
    });

    Object.defineProperty(compiler, 'program', { get: () => builder.languageService.getProgram() });
    return compiler;
}

function resolveProject(project: string) {
    const possibleProject = resolve(project, "tsconfig.json");
    return existsSync(possibleProject) ? possibleProject : project;
}