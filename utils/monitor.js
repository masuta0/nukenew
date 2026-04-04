// utils/monitor.js

/**
 * Monitoring Utility
 * This utility handles logging and management commands.
 *
 * Usage:
 * const monitor = require('./utils/monitor');
 * monitor.log('message');
 * monitor.executeCommand('command');
 */

class Monitor {
    constructor() {
        this.logs = [];
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const logEntry = `${timestamp} - ${message}`;
        this.logs.push(logEntry);
        console.log(logEntry);
    }

    executeCommand(command) {
        this.log(`Executing command: ${command}`);
        // Placeholder for command execution logic
        // Implement command execution here
    }

    getLogs() {
        return this.logs;
    }
}

module.exports = new Monitor();