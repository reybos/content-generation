/* START GENAI */

import fs from 'fs-extra';
import path from 'path';
import { Logger } from '../../utils';

/**
 * Processing stage enum
 */
export enum ProcessingStage {
    INITIALIZING = 'initializing',
    PROCESSING_SCENES = 'processing_scenes',
    FINALIZING = 'finalizing',
    COMPLETED = 'completed',
    FAILED = 'failed',
}

/**
 * Interface for processing state
 */
export interface ProcessingState {
    workerId: string;
    startTime: number;
    lastUpdated: number;
    currentStage: ProcessingStage;
    completedScenes: number[];
    currentScene: number | null;
    failedAttempts: number;
    maxRetries: number;
    error: string;
    cooldownUntil?: number; // Timestamp until which this folder should be in cooldown
}

/**
 * Service for managing processing state
 */
export class StateService {
    private logger: Logger;
    private stateFileName = 'state.json';

    constructor() {
        this.logger = new Logger();
    }

    public async initializeState(
        folderPath: string,
        workerId: string,
        maxRetries = 3
    ): Promise<ProcessingState> {
        const statePath = path.join(folderPath, this.stateFileName);
        try {
            if (await fs.pathExists(statePath)) {
                const existingState = await fs.readJson(statePath) as ProcessingState;

                const updatedState: ProcessingState = {
                    ...existingState,
                    workerId,
                    lastUpdated: Date.now(),
                    failedAttempts: existingState.failedAttempts + 1,
                };

                await fs.writeJson(statePath, updatedState, { spaces: 2 });
                this.logger.info(`Resumed existing state for ${folderPath}`);
                return updatedState;
            } else {
                const newState: ProcessingState = {
                    workerId,
                    startTime: Date.now(),
                    lastUpdated: Date.now(),
                    currentStage: ProcessingStage.INITIALIZING,
                    completedScenes: [],
                    currentScene: null,
                    failedAttempts: 0,
                    maxRetries,
                    error: '',
                };

                await fs.writeJson(statePath, newState, { spaces: 2 });
                this.logger.info(`Initialized new state for ${folderPath}`);
                return newState;
            }
        } catch (error) {
            this.logger.error(`Failed to initialize state for ${folderPath}`, error);
            throw error;
        }
    }

    public async updateState(
        folderPath: string,
        updates: Partial<ProcessingState>
    ): Promise<ProcessingState> {
        const statePath = path.join(folderPath, this.stateFileName);
        try {
            const existingState = await this.getState(folderPath);
            if (!existingState) {
                throw new Error(`No state found for ${folderPath}`);
            }

            const updatedState: ProcessingState = {
                ...existingState,
                ...updates,
                lastUpdated: Date.now(),
            };

            await fs.writeJson(statePath, updatedState, { spaces: 2 });
            return updatedState;
        } catch (error) {
            this.logger.error(`Failed to update state for ${folderPath}`, error);
            throw error;
        }
    }

    public async getState(folderPath: string): Promise<ProcessingState | null> {
        const statePath = path.join(folderPath, this.stateFileName);
        try {
            if (await fs.pathExists(statePath)) {
                return await fs.readJson(statePath) as ProcessingState;
            } else {
                return null;
            }
        } catch (error) {
            this.logger.error(`Failed to get state for ${folderPath}`, error);
            return null;
        }
    }

    public async markSceneCompleted(folderPath: string, sceneNumber: number): Promise<ProcessingState> {
        try {
            const state = await this.getState(folderPath);
            if (!state) throw new Error(`No state found for ${folderPath}`);

            if (!state.completedScenes.includes(sceneNumber)) {
                const completedScenes = [...state.completedScenes, sceneNumber];
                return this.updateState(folderPath, {
                    completedScenes,
                    currentScene: null,
                    currentStage: ProcessingStage.PROCESSING_SCENES,
                });
            }

            return state;
        } catch (error) {
            this.logger.error(`Failed to mark scene ${sceneNumber} as completed for ${folderPath}`, error);
            throw error;
        }
    }

    public async setCurrentScene(folderPath: string, sceneNumber: number): Promise<ProcessingState> {
        try {
            return await this.updateState(folderPath, {
                currentScene: sceneNumber,
                currentStage: ProcessingStage.PROCESSING_SCENES,
            });
        } catch (error) {
            this.logger.error(`Failed to set current scene to ${sceneNumber} for ${folderPath}`, error);
            throw error;
        }
    }

    public async markCompleted(folderPath: string): Promise<ProcessingState> {
        try {
            return await this.updateState(folderPath, {
                currentStage: ProcessingStage.COMPLETED,
                currentScene: null,
            });
        } catch (error) {
            this.logger.error(`Failed to mark processing as completed for ${folderPath}`, error);
            throw error;
        }
    }

    /**
     * Mark processing as failed
     * @param folderPath Path to the folder
     * @param error Error message
     * @param cooldownMs Optional cooldown period in milliseconds (default: 60000ms = 1 minute)
     * @returns Promise resolving to the updated state
     */
    public async markFailed(folderPath: string, error: string, cooldownMs: number = 60000): Promise<ProcessingState> {
        try {
            return this.updateState(folderPath, {
                currentStage: ProcessingStage.FAILED,
                error,
                cooldownUntil: Date.now() + cooldownMs
            });
        } catch (error) {
            this.logger.error(`Failed to mark processing as failed for ${folderPath}`, error);
            throw error;
        }
    }

    /**
     * Check if a folder is in cooldown period
     * @param folderPath Path to the folder
     * @returns Promise resolving to true if folder is in cooldown, false otherwise
     */
    public async isInCooldown(folderPath: string): Promise<boolean> {
        try {
            const state = await this.getState(folderPath);

            if (!state || !state.cooldownUntil) {
                return false;
            }

            return state.cooldownUntil > Date.now();
        } catch (error) {
            this.logger.error(`Failed to check cooldown for ${folderPath}`, error);
            return false;
        }
    }

    public async hasExceededMaxRetries(folderPath: string): Promise<boolean> {
        try {
            const state = await this.getState(folderPath);
            if (!state) return false;
            return state.failedAttempts >= state.maxRetries;
        } catch (error) {
            this.logger.error(`Failed to check max retries for ${folderPath}`, error);
            return false;
        }
    }

    public async findFailedFolders(baseDir: string): Promise<string[]> {
        try {
            const folders = await fs.readdir(baseDir);
            const failedFolders: string[] = [];

            for (const folder of folders) {
                const folderPath = path.join(baseDir, folder);
                const statePath = path.join(folderPath, this.stateFileName);

                if ((await fs.stat(folderPath)).isDirectory() && await fs.pathExists(statePath)) {
                    const state = await this.getState(folderPath);
                    if (state && state.currentStage === ProcessingStage.FAILED) {
                        failedFolders.push(folderPath);
                    }
                }
            }

            return failedFolders;
        } catch (error) {
            this.logger.error(`Error finding failed folders in ${baseDir}`, error);
            return [];
        }
    }

    public async findIncompleteFolders(baseDir: string): Promise<string[]> {
        try {
            const folders = await fs.readdir(baseDir);
            const incompleteFolders: string[] = [];

            for (const folder of folders) {
                const folderPath = path.join(baseDir, folder);
                const statePath = path.join(folderPath, this.stateFileName);

                if ((await fs.stat(folderPath)).isDirectory() && await fs.pathExists(statePath)) {
                    const state = await this.getState(folderPath);
                    if (state &&
                        state.currentStage !== ProcessingStage.COMPLETED &&
                        state.currentStage !== ProcessingStage.FAILED) {
                        incompleteFolders.push(folderPath);
                    }
                }
            }

            return incompleteFolders;
        } catch (error) {
            this.logger.error(`Error finding incomplete folders in ${baseDir}`, error);
            return [];
        }
    }
}

/* END GENAI */