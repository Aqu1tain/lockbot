const fs = require('fs/promises');
const path = require('path');

const DEFAULT_GUILD_STATE = {
  enabled: false,
  maintenanceChannelId: null,
  shouldDeleteMaintenanceChannel: false,
  maintenanceTempRoleId: null,
  shouldDeleteTempRole: false,
  maintenanceBypassRoleId: null,
  shouldDeleteBypassRole: false,
  memberRoleSnapshots: {},
  channelPermissionSnapshots: {},
  everyoneViewPermission: null,
  timeoutAt: null,
  timeoutSetBy: null,
  lastAnnouncement: null,
  logs: [],
};

const DEFAULT_STATE = {
  guilds: {},
};

class StateManager {
  constructor(filename = 'data/state.json') {
    this.filePath = path.resolve(process.cwd(), filename);
    this.lock = Promise.resolve();
  }

  async _withLock(fn) {
    const run = this.lock.then(() => fn());
    this.lock = run.catch(() => {});
    return run;
  }

  async _readFile() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      const guilds = {};

      for (const [guildId, state] of Object.entries(data.guilds ?? {})) {
        guilds[guildId] = {
          ...DEFAULT_GUILD_STATE,
          ...state,
        };
      }

      return { guilds };
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this._writeFile(DEFAULT_STATE);
        return { guilds: {} };
      }
      throw error;
    }
  }

  async _writeFile(data) {
    const payload = JSON.stringify(data, null, 2);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${payload}\n`, 'utf8');
  }

  async getGuildState(guildId) {
    const data = await this._readFile();
    return data.guilds[guildId] ? { ...data.guilds[guildId] } : { ...DEFAULT_GUILD_STATE };
  }

  async setGuildState(guildId, newState) {
    return this._withLock(async () => {
      const data = await this._readFile();
      data.guilds[guildId] = {
        ...DEFAULT_GUILD_STATE,
        ...newState,
      };
      await this._writeFile(data);
      return data.guilds[guildId];
    });
  }

  async updateGuildState(guildId, updater) {
    return this._withLock(async () => {
      const data = await this._readFile();
      const current = data.guilds[guildId]
        ? { ...DEFAULT_GUILD_STATE, ...data.guilds[guildId] }
        : { ...DEFAULT_GUILD_STATE };
      const updated = await updater({ ...current });
      data.guilds[guildId] = {
        ...DEFAULT_GUILD_STATE,
        ...updated,
      };
      await this._writeFile(data);
      return data.guilds[guildId];
    });
  }

  async deleteGuildState(guildId) {
    return this._withLock(async () => {
      const data = await this._readFile();
      if (guildId in data.guilds) {
        delete data.guilds[guildId];
        await this._writeFile(data);
      }
    });
  }
}

module.exports = {
  StateManager,
  DEFAULT_GUILD_STATE,
};
