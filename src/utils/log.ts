import log4js from "log4js";

const logger = log4js.configure({
    appenders: {
        console: { type: "console" },
    },
    categories: {
        default: {
            appenders: ["console"],
            level: "debug" // Set the logging level to debug
        }
    }
})

export function setLog() {
    logger.configure({
        appenders: {
            console: { type: "console" },
        },
        categories: {
            default: {
                appenders: ["console"],
                level: process.env.APP_LOGGER_LEVEL || "debug"// Set the logging level to debug
            }
        }
    })
}


export default logger.getLogger();

const getLogger = logger.getLogger; // Get the getLogger function from the logger object
export {
    logger, // Export the logger object
    getLogger // Export the getLogger function for convenience
}