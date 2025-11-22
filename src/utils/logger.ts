/* START GENAI */
/**
 * Simple logger utility for the application
 */
export class Logger {
    /**
     * Log an informational message
     * @param message The message to log
     * @param data Optional data to include in the log
     */
    public info(message: string, data?: unknown): void {
        this.log('INFO', message, data);
    }

    /**
     * Log a warning message
     * @param message The message to log
     * @param data Optional data to include in the log
     */
    public warn(message: string, data?: unknown): void {
        this.log('WARN', message, data);
    }

    /**
     * Log an error message
     * @param message The message to log
     * @param error Optional error to include in the log
     */
    public error(message: string, error?: unknown): void {
        this.log('ERROR', message, error);
    }

    /**
     * Internal method to format and output log messages
     * @param level The log level
     * @param message The message to log
     * @param data Optional data to include in the log
     */
    private log(level: string, message: string, data?: unknown): void {
        const timestamp: string = new Date().toISOString();
        const formattedMessage = `[${timestamp}] [${level}] ${message}`;
        if (data) {
            console.log(formattedMessage, data);
        } else {
            console.log(formattedMessage);
        }
    }
}
/* END GENAI */