/**
 * Minimal Node-RED settings for cloud deployment (Render / Docker).
 * Node-RED fills in the rest of the defaults automatically.
 */
module.exports = {
    // Render injects PORT; Node-RED listens on it automatically.
    uiPort: process.env.PORT || 1880,
    uiHost: '0.0.0.0',

    flowFile: 'flows.json',

    // Required so credentials are encrypted with a stable key across restarts.
    credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || 'billing-demo-secret-change-me',

    // Allow function nodes to require npm modules if needed.
    functionExternalModules: true,
    functionGlobalContext: {},

    editorTheme: {
        projects: { enabled: false },
        tours: false
    },

    logging: {
        console: { level: 'info', metrics: false, audit: false }
    }
};

// Optional editor login. Active only when NODE_RED_USERNAME/NODE_RED_PASSWORD are set.
if (process.env.NODE_RED_USERNAME && process.env.NODE_RED_PASSWORD) {
    try {
        const bcrypt = require('bcryptjs');
        module.exports.adminAuth = {
            type: 'credentials',
            users: [{
                username: process.env.NODE_RED_USERNAME,
                password: bcrypt.hashSync(process.env.NODE_RED_PASSWORD, 8),
                permissions: '*'
            }]
        };
    } catch (error) {
        console.warn('adminAuth disabled (bcryptjs not available):', error.message);
    }
}
