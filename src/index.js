const { createLockBot } = require('./lockBot');

if (require.main === module) {
  require('dotenv').config();

  const token = process.env.DISCORD_TOKEN;
  const maintenanceChannelName = process.env.MAINTENANCE_CHANNEL_NAME || 'maintenance';
  const stateFile = process.env.STATE_FILE || 'data/state.json';

  if (!token) {
    console.error('DISCORD_TOKEN is not set. Populate it in a .env file.');
    process.exit(1);
  }

  const bot = createLockBot({
    token,
    maintenanceChannelName,
    stateFile,
  });

  bot.login().catch((error) => {
    console.error('Failed to login to Discord:', error);
    process.exit(1);
  });
}

module.exports = {
  createLockBot,
};
