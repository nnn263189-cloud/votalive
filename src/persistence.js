import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadState(filePath, logger = console) {
  if (!filePath) return null;
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.error(`[Estado] Não foi possível carregar ${filePath}:`, error?.message || error);
    }
    return null;
  }
}

export class StatePersistence {
  constructor(filePath, { logger = console, delayMs = 100 } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    this.delayMs = delayMs;
    this.pending = null;
    this.timer = null;
    this.writeQueue = Promise.resolve();
  }

  schedule(state) {
    if (!this.filePath) return;
    this.pending = `${JSON.stringify(state, null, 2)}\n`;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  async flush() {
    if (!this.filePath) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const content = this.pending;
    this.pending = null;
    if (content === null) {
      await this.writeQueue;
      return;
    }

    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const directory = path.dirname(this.filePath);
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await mkdir(directory, { recursive: true });
        await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      })
      .catch((error) => {
        this.logger.error('[Estado] Falha ao salvar o placar:', error?.message || error);
      });

    await this.writeQueue;
    if (this.pending !== null) await this.flush();
  }
}
