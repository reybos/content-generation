/* START GENAI */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { Logger } from '../../utils';

/**
 * Interface for lock file content
 */
export interface LockFile {
    workerId: string;
    hostname: string;
    pid: number;
    createdAt: number;
    lastHeartbeat: number;
}

/**
 * Service for managing distributed locks using the filesystem
 */
export class LockService {
    private logger: Logger;
    private workerId: string;
    private hostname: string;
    private pid: number;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private readonly staleThresholdMs = 5 * 60 * 1000; // 5 minutes
    private readonly heartbeatIntervalMs = 30 * 1000; // 30 seconds

    constructor() {
        this.logger = new Logger();
        this.workerId = crypto.randomUUID();
        this.hostname = os.hostname();
        this.pid = process.pid;
    }

    public async acquireLock(folderPath: string): Promise<boolean> {
        const lockFilePath = path.join(folderPath, '.lock');

        try {
            if (await fs.pathExists(lockFilePath)) {
                const isStale = await this.isLockStale(lockFilePath);
                if (!isStale) {
                    this.logger.info(`Folder ${folderPath} is already locked by another worker`);
                    return false;
                }

                this.logger.info(`Found stale lock in ${folderPath}, acquiring lock`);
            }

            const lockData: LockFile = {
                workerId: this.workerId,
                hostname: this.hostname,
                pid: this.pid,
                createdAt: Date.now(),
                lastHeartbeat: Date.now(),
            };

            const tempLockPath = `${lockFilePath}.${this.workerId}.tmp`;
            await fs.writeJson(tempLockPath, lockData, { spaces: 2 });
            await fs.move(tempLockPath, lockFilePath, { overwrite: true });

            this.startHeartbeat(lockFilePath);
            this.logger.info(`Successfully acquired lock for ${folderPath}`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to acquire lock for ${folderPath}`, error);
            return false;
        }
    }

    public async releaseLock(folderPath: string): Promise<void> {
        const lockFilePath = path.join(folderPath, '.lock');

        try {
            if (await this.isOurLock(lockFilePath)) {
                this.stopHeartbeat();
                await fs.remove(lockFilePath);
                this.logger.info(`Released lock for ${folderPath}`);
            } else {
                this.logger.warn(`Cannot release lock for ${folderPath} as it is not owned by this worker`);
            }
        } catch (error) {
            this.logger.error(`Failed to release lock for ${folderPath}`, error);
        }
    }

    /**
     * Force remove lock file without checking ownership
     * Useful when moving folders between directories
     */
    public async forceRemoveLock(folderPath: string): Promise<void> {
        const lockFilePath = path.join(folderPath, '.lock');

        try {
            if (await fs.pathExists(lockFilePath)) {
                await fs.remove(lockFilePath);
                this.logger.info(`Force removed lock for ${folderPath}`);
            }
        } catch (error) {
            this.logger.error(`Failed to force remove lock for ${folderPath}`, error);
        }
    }

    public async isLocked(folderPath: string): Promise<boolean> {
        const lockFilePath = path.join(folderPath, '.lock');
        
        try {
            if (!(await fs.pathExists(lockFilePath))) {
                return false;
            }

            const isStale = await this.isLockStale(lockFilePath);
            return !isStale; // Если блокировка не устарела, значит папка заблокирована
        } catch (error) {
            this.logger.error(`Error checking if folder is locked: ${folderPath}`, error);
            return false; // В случае ошибки считаем, что папка не заблокирована
        }
    }

    private async isLockStale(lockFilePath: string): Promise<boolean> {
        try {
            if (!(await fs.pathExists(lockFilePath))) {
                return true;
            }

            const lockData = await fs.readJson(lockFilePath) as LockFile;
            const now = Date.now();
            return now - lockData.lastHeartbeat > this.staleThresholdMs;
        } catch (error) {
            this.logger.error(`Error checking if lock is stale: ${lockFilePath}`, error);
            return true;
        }
    }

    private async isOurLock(lockFilePath: string): Promise<boolean> {
        try {
            if (!(await fs.pathExists(lockFilePath))) {
                return false;
            }

            const lockData = await fs.readJson(lockFilePath) as LockFile;
            return lockData.workerId === this.workerId;
        } catch (error) {
            this.logger.error(`Error checking if lock is ours: ${lockFilePath}`, error);
            return false;
        }
    }

    private startHeartbeat(lockFilePath: string): void {
        this.stopHeartbeat();

        this.heartbeatInterval = setInterval(async () => {
            try {
                if (!(await fs.pathExists(lockFilePath))) {
                    this.stopHeartbeat();
                    return;
                }

                const lockData = await fs.readJson(lockFilePath) as LockFile;
                if (lockData.workerId === this.workerId) {
                    lockData.lastHeartbeat = Date.now();
                    await fs.writeJson(lockFilePath, lockData, { spaces: 2 });
                } else {
                    this.stopHeartbeat();
                }
            } catch (error) {
                this.logger.error(`Error updating heartbeat for ${lockFilePath}`, error);
            }
        }, this.heartbeatIntervalMs);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    public getWorkerId(): string {
        return this.workerId;
    }

    public async findFoldersWithStaleLocks(baseDir: string): Promise<string[]> {
        try {
            const folders = await fs.readdir(baseDir);
            const staleFolders: string[] = [];

            for (const folder of folders) {
                const folderPath = path.join(baseDir, folder);
                const lockFilePath = path.join(folderPath, '.lock');

                if ((await fs.stat(folderPath)).isDirectory() && await fs.pathExists(lockFilePath)) {
                    if (await this.isLockStale(lockFilePath)) {
                        staleFolders.push(folderPath);
                    }
                }
            }

            return staleFolders;
        } catch (error) {
            this.logger.error(`Error finding folders with stale locks in ${baseDir}`, error);
            return [];
        }
    }

    public async findFoldersWithoutLocks(baseDir: string): Promise<string[]> {
        try {
            const folders = await fs.readdir(baseDir);
            const unlockFolders: string[] = [];

            for (const folder of folders) {
                const folderPath = path.join(baseDir, folder);
                const lockFilePath = path.join(folderPath, '.lock');

                if ((await fs.stat(folderPath)).isDirectory() && !(await fs.pathExists(lockFilePath))) {
                    unlockFolders.push(folderPath);
                }
            }

            return unlockFolders;
        } catch (error) {
            this.logger.error(`Error finding folders without locks in ${baseDir}`, error);
            return [];
        }
    }
}

/* END GENAI */