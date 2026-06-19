module.exports = {
  apps: [
    {
      name: "mishi-room",
      script: "server.mjs",
      cwd: "/www/wwwroot/mishi.zlbigger.com",
      env: {
        NODE_ENV: "production",
        PORT: "4173"
      }
    }
  ]
};
