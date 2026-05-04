import * as path from 'path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

function sanitizeVSCodeLaunchEnvironment() {
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.VSCODE_CLI;
    delete process.env.VSCODE_ESM_ENTRYPOINT;
    delete process.env.VSCODE_HANDLES_UNCAUGHT_ERRORS;
    delete process.env.VSCODE_NLS_CONFIG;
    delete process.env.VSCODE_IPC_HOOK;
    delete process.env.VSCODE_PID;
}

async function main() {
    try {
        sanitizeVSCodeLaunchEnvironment();

        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        const downloadedExecutablePath = await downloadAndUnzipVSCode();
        const vscodeExecutablePath = process.platform === 'darwin'
            ? downloadedExecutablePath.replace(/Electron$/, 'Code')
            : downloadedExecutablePath;

        await runTests({
            extensionDevelopmentPath: extensionDevelopmentPath,
            extensionTestsPath: extensionTestsPath,
            vscodeExecutablePath: vscodeExecutablePath
        });
    } catch (error) {
        console.error('Failed to run tests');
        if (error) {
            console.error(error);
        }
        process.exit(1);
    }
}

main();
