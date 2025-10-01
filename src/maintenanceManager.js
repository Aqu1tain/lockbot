const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { DEFAULT_GUILD_STATE } = require('./stateManager');

class MaintenanceManager {
  constructor(stateManager, options = {}) {
    this.stateManager = stateManager;
    this.maintenanceChannelName = options.maintenanceChannelName || 'maintenance';
  }

  getRestrictedRoles(guild) {
    return guild.roles.cache.filter((role) => !role.permissions.has(PermissionFlagsBits.Administrator));
  }

  async findOrCreateMaintenanceChannel(guild, state = DEFAULT_GUILD_STATE) {
    if (state.maintenanceChannelId) {
      const existing = await guild.channels.fetch(state.maintenanceChannelId).catch(() => null);
      if (existing) {
        return { channel: existing, created: false };
      }
    }

    const channel = await guild.channels.create({
      name: this.maintenanceChannelName,
      type: ChannelType.GuildText,
      topic: 'Temporary maintenance channel',
      reason: 'Maintenance mode activated',
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages],
        },
      ],
    });

    return { channel, created: true };
  }

  async enable(guild, options = {}) {
    await guild.channels.fetch();

    const { timeoutAt = null, timeoutSetBy = null } = options;

    return this.stateManager.updateGuildState(guild.id, async (current) => {
      if (current.enabled) {
        return current;
      }

      const { channel: maintenanceChannel, created } = await this.findOrCreateMaintenanceChannel(guild, current);
      const restrictedRoles = this.getRestrictedRoles(guild);
      const overwrites = {};

      for (const channel of guild.channels.cache.values()) {
        if (!channel.manageable || channel.id === maintenanceChannel.id || channel.isThread()) {
          continue;
        }

        const channelData = {};
        for (const role of restrictedRoles.values()) {
          const overwrite = channel.permissionOverwrites.cache.get(role.id);
          const hadAllow = overwrite?.allow.has(PermissionsBitField.Flags.ViewChannel) ?? false;
          const hadDeny = overwrite?.deny.has(PermissionsBitField.Flags.ViewChannel) ?? false;
          const previous = hadAllow ? 'allow' : hadDeny ? 'deny' : 'neutral';

          if (previous === 'deny') {
            continue;
          }

          try {
            await channel.permissionOverwrites.edit(role, { ViewChannel: false });
            channelData[role.id] = previous;
          } catch (error) {
            console.error(`Failed to deny access for ${role.name} in ${channel.name}`, error);
          }
        }

        if (Object.keys(channelData).length > 0) {
          overwrites[channel.id] = channelData;
        }
      }

      return {
        enabled: true,
        maintenanceChannelId: maintenanceChannel.id,
        shouldDeleteMaintenanceChannel: created,
        overwrites,
        timeoutAt,
        timeoutSetBy,
      };
    });
  }

  async disable(guild) {
    await guild.channels.fetch();

    return this.stateManager.updateGuildState(guild.id, async (current) => {
      if (!current.enabled) {
        return current;
      }

      for (const [channelId, roles] of Object.entries(current.overwrites || {})) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel || !channel.manageable) {
          continue;
        }

        for (const [roleId, previous] of Object.entries(roles)) {
          const role = guild.roles.cache.get(roleId);
          if (!role) {
            continue;
          }

          const payload =
            previous === 'allow'
              ? { ViewChannel: true }
              : previous === 'deny'
              ? { ViewChannel: false }
              : { ViewChannel: null };

          try {
            await channel.permissionOverwrites.edit(role, payload);
          } catch (error) {
            console.error(`Failed to restore access for ${role.name} in ${channel.name}`, error);
          }
        }
      }

      if (current.maintenanceChannelId) {
        const maintenanceChannel = guild.channels.cache.get(current.maintenanceChannelId);
        if (maintenanceChannel && current.shouldDeleteMaintenanceChannel) {
          try {
            await maintenanceChannel.delete('Maintenance mode disabled');
          } catch (error) {
            console.error('Could not delete maintenance channel', error);
          }
        }
      }

      return {
        enabled: false,
        maintenanceChannelId: current.shouldDeleteMaintenanceChannel ? null : current.maintenanceChannelId,
        shouldDeleteMaintenanceChannel: false,
        overwrites: {},
        timeoutAt: null,
        timeoutSetBy: null,
      };
    });
  }

  async applyRestrictionsToChannel(guild, channel) {
    return this.stateManager.updateGuildState(guild.id, async (current) => {
      if (!current.enabled) {
        return current;
      }

      if (!channel || channel.isThread?.() || !channel.manageable) {
        return current;
      }

      if (current.maintenanceChannelId && channel.id === current.maintenanceChannelId) {
        return current;
      }

      const restrictedRoles = this.getRestrictedRoles(guild);
      if (!restrictedRoles.size) {
        return current;
      }

      const existingChannelState = current.overwrites?.[channel.id] ?? {};
      const updatedChannelState = { ...existingChannelState };
      let changed = false;

      for (const role of restrictedRoles.values()) {
        const overwrite = channel.permissionOverwrites.cache.get(role.id);
        const hadAllow = overwrite?.allow.has(PermissionsBitField.Flags.ViewChannel) ?? false;
        const hadDeny = overwrite?.deny.has(PermissionsBitField.Flags.ViewChannel) ?? false;
        const previous = hadAllow ? 'allow' : hadDeny ? 'deny' : 'neutral';

        if (previous === 'deny') {
          continue;
        }

        try {
          await channel.permissionOverwrites.edit(role, { ViewChannel: false });
          if (!(role.id in updatedChannelState)) {
            updatedChannelState[role.id] = previous;
          }
          changed = true;
        } catch (error) {
          console.error(`Failed to deny access for ${role.name} in ${channel.name}`, error);
        }
      }

      if (!changed) {
        return current;
      }

      return {
        ...current,
        overwrites: {
          ...current.overwrites,
          [channel.id]: updatedChannelState,
        },
      };
    });
  }

  async sendAnnouncement(guild, options = {}) {
    const { authorId = null, content = null, embed = null, components = [] } = options;

    const trimmedContent = content?.trim();
    const embedData = embed?.data ?? (embed && typeof embed === 'object' && !Array.isArray(embed) ? embed : null);

    if (!trimmedContent && !embedData) {
      const error = new Error('Announcement payload must include content or an embed.');
      error.code = 'EMPTY_ANNOUNCEMENT';
      throw error;
    }

    return this.stateManager.updateGuildState(guild.id, async (current) => {
      if (!current.enabled) {
        const error = new Error('Maintenance mode is not enabled.');
        error.code = 'MAINTENANCE_NOT_ENABLED';
        throw error;
      }

      const { channel, created } = await this.findOrCreateMaintenanceChannel(guild, current);
      if (!channel.isTextBased()) {
        const error = new Error('Maintenance channel is not text-based.');
        error.code = 'MAINTENANCE_CHANNEL_INVALID';
        throw error;
      }

      const payload = {
        content: trimmedContent ?? undefined,
        embeds: embedData ? [embed] : undefined,
        components: components.length > 0 ? components : undefined,
      };

      await channel.send(payload);

      return {
        ...current,
        maintenanceChannelId: channel.id,
        shouldDeleteMaintenanceChannel: current.shouldDeleteMaintenanceChannel || created,
        lastAnnouncement: {
          content: trimmedContent ?? embedData?.description ?? null,
          title: embedData?.title ?? null,
          timestamp: new Date().toISOString(),
          authorId: authorId ?? null,
        },
      };
    });
  }

  async getStatus(guildId) {
    return this.stateManager.getGuildState(guildId);
  }
}

module.exports = MaintenanceManager;
