import * as path from 'path';
import * as Mocha from 'mocha';
import * as glob from 'glob';

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    const testsRoot = path.resolve(__dirname, '..');

    return new Promise((resolve, reject) => {
        glob('**/**.test.js', { cwd: testsRoot }, (error: Error | null, files: string[]) => {
            if (error) {
                reject(error);
                return;
            }

            files.forEach((file: string) => mocha.addFile(path.resolve(testsRoot, file)));

            try {
                mocha.run(failures => {
                    if (failures > 0) {
                        reject(new Error(`${failures} tests failed.`));
                        return;
                    }
                    resolve();
                });
            } catch (runError) {
                reject(runError);
            }
        });
    });
}
