module.exports = {
    apps: [
        {
            name: 'antigravity-proxy',
            cwd: __dirname,
            script: 'src/index.js',
            interpreter: 'node',
            exec_mode: 'fork',
            instances: 1,
            autorestart: true,
            watch: false,
            windowsHide: true,
            max_memory_restart: '512M'
        }
    ]
};
