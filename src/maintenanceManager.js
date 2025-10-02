const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { DEFAULT_GUILD_STATE } = require('./stateManager');

const TEMP_ROLE_NAME = 'maintenance-temp';
const BYPASS_ROLE_NAME = 'maintenance-bypass';
const DEFAULT_SLOWMODE_SECONDS = 10;
const MAX_LOG_ENTRIES = 1000;
const EMPTY_PERMISSIONS = new PermissionsBitField(0n);

class MaintenanceManager {
  constructor(stateManager, options = {}) {
    this.stateManager = stateManager;
    this.maintenanceChannelName = options.maintenanceChannelName || 'maintenance';
  }

  async ensureRole({ guild, roleId, roleName, permissions = null, reason, managedCallback }) {
    if (roleId) {
      const existing = guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
      if (existing) {
        if (permissions !== undefined) {
          const hasPermissions = new PermissionsBitField(existing.permissions);
          const target = new PermissionsBitField(permissions);
          if (!hasPermissions.equals(target)) {
            await existing.setPermissions(target, reason);
          }
        }
        if (managedCallback) {
          await managedCallback(existing);
        }
        return { role: existing, created: false };
      }
    }

    const byName = guild.roles.cache.find((role) => role.name === roleName);
    if (byName) {
      if (permissions !== undefined) {
        const hasPermissions = new PermissionsBitField(byName.permissions);
        const target = new PermissionsBitField(permissions);
        if (!hasPermissions.equals(target)) {
          await byName.setPermissions(target, reason);
        }
      }
      if (managedCallback) {
        await managedCallback(byName);
      }
      return { role: byName, created: false };
    }

    const role = await guild.roles.create({
      name: roleName,
      permissions: permissions ?? EMPTY_PERMISSIONS,
      reason,
    });

    if (managedCallback) {
      await managedCallback(role);
    }

    return { role, created: true };
  }

  async findOrCreateMaintenanceChannel(guild, state, { tempRole, bypassRole }) {
    let channel = null;
    let created = false;

    if (state.maintenanceChannelId) {
      channel = await guild.channels.fetch(state.maintenanceChannelId).catch(() => null);
    }

    if (!channel) {
      channel = guild.channels.cache.find(
        (ch) => ch.name === this.maintenanceChannelName && ch.type === ChannelType.GuildText
      );
    }

    if (!channel) {
      channel = await guild.channels.create({
        name: this.maintenanceChannelName,
        type: ChannelType.GuildText,
        topic: 'Temporary maintenance channel',
        reason: 'Maintenance mode activated',
      });
      created = true;
    }

    await this.configureMaintenanceChannel(guild, channel, { tempRole, bypassRole });
    return { channel, created };
  }

  async configureMaintenanceChannel(guild, channel, { tempRole, bypassRole }) {
    const tasks = [];

    tasks.push(
      channel.permissionOverwrites.edit(
        guild.roles.everyone,
        {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        },
        { reason: 'Maintenance mode configuration' }
      )
    );

    if (tempRole) {
      tasks.push(
        channel.permissionOverwrites.edit(
          tempRole,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          },
          { reason: 'Maintenance mode configuration' }
        )
      );
    }

    if (bypassRole) {
      tasks.push(
        channel.permissionOverwrites.edit(
          bypassRole,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          },
          { reason: 'Maintenance mode configuration' }
        )
      );
    }

    await Promise.all(tasks);

    if (channel.rateLimitPerUser !== DEFAULT_SLOWMODE_SECONDS) {
      await channel.setRateLimitPerUser(DEFAULT_SLOWMODE_SECONDS, 'Maintenance mode slowmode');
    }
  }

  async ensureMaintenanceInfrastructure(guild, state) {
    await guild.roles.fetch();

    const tempRoleResult = await this.ensureRole({
      guild,
      roleId: state.maintenanceTempRoleId,
      roleName: TEMP_ROLE_NAME,
      permissions: EMPTY_PERMISSIONS,
      reason: 'Maintenance mode setup: temporary role',
      managedCallback: async (role) => {
        const perms = new PermissionsBitField(role.permissions);
        if (!perms.equals(EMPTY_PERMISSIONS)) {
          await role.setPermissions(EMPTY_PERMISSIONS, 'Reset maintenance-temp permissions');
        }
      },
    });

    const bypassRoleResult = await this.ensureRole({
      guild,
      roleId: state.maintenanceBypassRoleId,
      roleName: BYPASS_ROLE_NAME,
      reason: 'Maintenance mode setup: bypass role',
      managedCallback: async (role) => {
        const perms = new PermissionsBitField(role.permissions);
        if (!perms.has(PermissionFlagsBits.ViewChannel)) {
          await role.setPermissions(perms.add(PermissionFlagsBits.ViewChannel), 'Ensure bypass can view channels');
        }
      },
    });

    return {
      tempRole: tempRoleResult.role,
      bypassRole: bypassRoleResult.role,
      createdTemp: tempRoleResult.created,
      createdBypass: bypassRoleResult.created,
    };
  }

  trimLogs(logs = []) {
    if (logs.length <= MAX_LOG_ENTRIES) {
      return logs;
    }
    return logs.slice(logs.length - MAX_LOG_ENTRIES);
  }

  async enable(guild, options = {}) {
    const { timeoutAt = null, timeoutSetBy = null } = options;

    await Promise.all([guild.members.fetch(), guild.roles.fetch(), guild.channels.fetch()]);

    return this.stateManager.updateGuildState(guild.id, async (current) => {
      if (current.enabled) {
        return current;
      }

      const logs = Array.isArray(current.logs) ? [...current.logs] : [];

      const {
        tempRole,
        bypassRole,
        createdTemp,
        createdBypass,
      } = await this.ensureMaintenanceInfrastructure(guild, current);

      const { channel: maintenanceChannel, created: createdChannel } = await this.findOrCreateMaintenanceChannel(
        guild,
        current,
        { tempRole, bypassRole }
      );

      const memberRoleSnapshots = {};
      let affectedMembers = 0;

      for (const member of guild.members.cache.values()) {
        if (member.user.bot) {
          continue;
        }

        if (member.permissions.has(PermissionFlagsBits.Administrator)) {
          continue;
        }

        if (member.roles.cache.has(bypassRole.id)) {
          continue;
        }

        const currentRoleIds = member.roles.cache
          .filter((role) => role.id !== guild.id && role.id !== tempRole.id)
          .map((role) => role.id);

        memberRoleSnapshots[member.id] = {
          roles: currentRoleIds,
          timestamp: new Date().toISOString(),
        };

        try {
          await member.roles.set([tempRole.id], 'Maintenance mode activated');
          affectedMembers += 1;
        } catch (error) {
          logs.push(`Failed to update roles for ${member.user.tag} (${member.id}): ${error.name}`);
        }
      }

      const everyoneRole = guild.roles.everyone;
      const hadViewPermission = everyoneRole.permissions.has(PermissionFlagsBits.ViewChannel);
      if (hadViewPermission) {
        try {
          await everyoneRole.setPermissions(
            everyoneRole.permissions.remove(PermissionFlagsBits.ViewChannel),
            'Maintenance mode activated'
          );
        } catch (error) {
          logs.push(`Failed to update @everyone permissions: ${error.name}`);
        }
      }

      const roleIdsForSnapshots = new Set();
      for (const snapshot of Object.values(memberRoleSnapshots)) {
        for (const roleId of snapshot.roles || []) {
          roleIdsForSnapshots.add(roleId);
        }
      }

      const roleChannelSnapshots = {};
      for (const roleId of roleIdsForSnapshots) {
        const role = guild.roles.cache.get(roleId);
        roleChannelSnapshots[roleId] = {
          name: role?.name || `Role ${roleId}`,
          channels: {},
        };
      }

      const channelPermissionSnapshots = {};
      let channelsLocked = 0;

      for (const channel of guild.channels.cache.values()) {
        if (channel.isThread?.() || !channel.manageable) {
          continue;
        }

        const overwrite = channel.permissionOverwrites.cache.get(everyoneRole.id);
        const hadAllow = overwrite?.allow.has(PermissionsBitField.Flags.ViewChannel) ?? false;
        const hadDeny = overwrite?.deny.has(PermissionsBitField.Flags.ViewChannel) ?? false;
        const previous = hadAllow ? 'allow' : hadDeny ? 'deny' : 'neutral';
        channelPermissionSnapshots[channel.id] = previous;

        for (const roleId of roleIdsForSnapshots) {
          const snapshot = roleChannelSnapshots[roleId];
          if (!snapshot) {
            continue;
          }
          const roleOverwrite = channel.permissionOverwrites.cache.get(roleId);
          const roleAllow = roleOverwrite?.allow.has(PermissionsBitField.Flags.ViewChannel) ?? false;
          const roleDeny = roleOverwrite?.deny.has(PermissionsBitField.Flags.ViewChannel) ?? false;
          const roleState = roleAllow ? 'allow' : roleDeny ? 'deny' : 'neutral';
          snapshot.channels[channel.id] = roleState;
        }

        if (channel.id === maintenanceChannel.id) {
          continue;
        }

        try {
          await channel.permissionOverwrites.edit(
            everyoneRole,
            { ViewChannel: false },
            { reason: 'Maintenance mode activated' }
          );
          channelsLocked += 1;
        } catch (error) {
          logs.push(`Failed to update @everyone overwrite in ${channel.name} (${channel.id}): ${error.name}`);
        }
      }

      logs.push(
        `Maintenance enabled by ${timeoutSetBy ? `<@${timeoutSetBy}>` : 'system'} — locked ${affectedMembers} members and ${channelsLocked} channels.`
      );

      return {
        enabled: true,
        maintenanceChannelId: maintenanceChannel.id,
        shouldDeleteMaintenanceChannel: createdChannel,
        maintenanceTempRoleId: tempRole.id,
        shouldDeleteTempRole: createdTemp,
        maintenanceBypassRoleId: bypassRole.id,
        shouldDeleteBypassRole: createdBypass,
        memberRoleSnapshots,
        channelPermissionSnapshots,
        roleChannelSnapshots,
        everyoneViewPermission: hadViewPermission ? 'allow' : 'deny',
        timeoutAt,
        timeoutSetBy,
        logs: this.trimLogs(logs),
      };
    });
  }

  async disable(guild, options = {}) {
    const roleMapping = options.roleMapping ?? {};

    await Promise.all([guild.members.fetch(), guild.roles.fetch(), guild.channels.fetch()]);

    return this.stateManager.updateGuildState(guild.id, async (current) => {
      if (!current.enabled) {
        return current;
      }

      const logs = Array.isArray(current.logs) ? [...current.logs] : [];
      const tempRole = current.maintenanceTempRoleId
        ? guild.roles.cache.get(current.maintenanceTempRoleId) || (await guild.roles.fetch(current.maintenanceTempRoleId).catch(() => null))
        : null;
      const bypassRole = current.maintenanceBypassRoleId
        ? guild.roles.cache.get(current.maintenanceBypassRoleId) || (await guild.roles.fetch(current.maintenanceBypassRoleId).catch(() => null))
        : null;

      let restoredMembers = 0;

      for (const [memberId, snapshot] of Object.entries(current.memberRoleSnapshots || {})) {
        let member = guild.members.cache.get(memberId);
        if (!member) {
          member = await guild.members.fetch(memberId).catch(() => null);
        }

        if (!member) {
          logs.push(`Skipping missing member ${memberId} during maintenance restore.`);
          continue;
        }

        const desiredRoleSet = new Set();
        for (const roleId of snapshot.roles || []) {
          if (guild.roles.cache.has(roleId)) {
            desiredRoleSet.add(roleId);
            continue;
          }

          const decision = roleMapping[roleId];
          if (decision?.action === 'replace' && guild.roles.cache.has(decision.targetRoleId)) {
            desiredRoleSet.add(decision.targetRoleId);
          } else {
            logs.push(`Role ${roleId} missing when restoring ${member.user.tag} (${member.id}).`);
          }
        }

        try {
          await member.roles.set(Array.from(desiredRoleSet), 'Maintenance mode disabled');
          restoredMembers += 1;
        } catch (error) {
          logs.push(`Failed to restore roles for ${member.user.tag} (${member.id}): ${error.name}`);
        }
      }

      if (tempRole) {
        await Promise.all(
          guild.members.cache
            .filter((member) => member.roles.cache.has(tempRole.id))
            .map((member) => member.roles.remove(tempRole, 'Maintenance mode disabled'))
        ).catch(() => {});
      }

      const everyoneRole = guild.roles.everyone;
      if (current.everyoneViewPermission === 'allow') {
        if (!everyoneRole.permissions.has(PermissionFlagsBits.ViewChannel)) {
          try {
            await everyoneRole.setPermissions(
              everyoneRole.permissions.add(PermissionFlagsBits.ViewChannel),
              'Maintenance mode disabled'
            );
          } catch (error) {
            logs.push(`Failed to restore @everyone permissions: ${error.name}`);
          }
        }
      }

      let channelsRestored = 0;
      for (const [channelId, previous] of Object.entries(current.channelPermissionSnapshots || {})) {
        const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
        if (!channel || !channel.manageable) {
          continue;
        }

        try {
          if (previous === 'neutral') {
            await channel.permissionOverwrites.delete(everyoneRole, 'Maintenance mode disabled');
          } else {
            await channel.permissionOverwrites.edit(
              everyoneRole,
              { ViewChannel: previous === 'allow' },
              { reason: 'Maintenance mode disabled' }
            );
          }
          channelsRestored += 1;
        } catch (error) {
          logs.push(`Failed to restore @everyone overwrite in ${channel?.name ?? channelId}: ${error.name}`);
        }
      }

      if (current.roleChannelSnapshots) {
        for (const [missingRoleId, decision] of Object.entries(roleMapping)) {
          if (decision?.action !== 'replace') {
            continue;
          }

          const snapshot = current.roleChannelSnapshots[missingRoleId];
          if (!snapshot) {
            continue;
          }

          const targetRole = guild.roles.cache.get(decision.targetRoleId) || (await guild.roles.fetch(decision.targetRoleId).catch(() => null));
          if (!targetRole) {
            logs.push(`Replacement role ${decision.targetRoleId} missing when restoring snapshot for ${missingRoleId}.`);
            continue;
          }

          for (const [channelId, viewState] of Object.entries(snapshot.channels || {})) {
            const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
            if (!channel || !channel.manageable) {
              continue;
            }

            try {
              if (viewState === 'neutral') {
                if (channel.permissionOverwrites.cache.has(targetRole.id)) {
                  await channel.permissionOverwrites.delete(targetRole, 'Maintenance role replacement');
                }
              } else {
                await channel.permissionOverwrites.edit(
                  targetRole,
                  { ViewChannel: viewState === 'allow' },
                  { reason: 'Maintenance role replacement' }
                );
              }
            } catch (error) {
              logs.push(`Failed to apply replacement overwrite in ${channel?.name ?? channelId} for role ${targetRole.id}: ${error.name}`);
            }
          }
        }
      }

      if (current.maintenanceChannelId) {
        const channel = await guild.channels.fetch(current.maintenanceChannelId).catch(() => null);
        if (channel) {
          if (current.shouldDeleteMaintenanceChannel) {
            await channel.delete('Maintenance mode disabled').catch(() => {});
          } else {
            await channel.setRateLimitPerUser(0, 'Maintenance mode disabled').catch(() => {});
            await channel.permissionOverwrites.delete(everyoneRole, 'Maintenance teardown').catch(() => {});
            if (tempRole) {
              await channel.permissionOverwrites.delete(tempRole, 'Maintenance teardown').catch(() => {});
            }
            if (bypassRole) {
              await channel.permissionOverwrites.delete(bypassRole, 'Maintenance teardown').catch(() => {});
            }
          }
        }
      }

      if (current.shouldDeleteTempRole && tempRole) {
        await tempRole.delete('Cleanup maintenance temp role').catch(() => {});
      }

      if (current.shouldDeleteBypassRole && bypassRole) {
        await bypassRole.delete('Cleanup maintenance bypass role').catch(() => {});
      }

      for (const [roleId, decision] of Object.entries(roleMapping)) {
        if (!decision) {
          continue;
        }
        const snapshot = current.roleChannelSnapshots?.[roleId];
        const roleName = snapshot?.name || `Role ${roleId}`;
        if (decision.action === 'replace') {
          logs.push(`Replaced ${roleName} with <@&${decision.targetRoleId}> during restore.`);
        } else if (decision.action === 'remove') {
          logs.push(`Removed ${roleName} from affected members during restore.`);
        }
      }

      logs.push(`Maintenance disabled — restored ${restoredMembers} members and ${channelsRestored} channels.`);

      return {
        enabled: false,
        maintenanceChannelId: current.shouldDeleteMaintenanceChannel ? null : current.maintenanceChannelId,
        shouldDeleteMaintenanceChannel: false,
        maintenanceTempRoleId: current.shouldDeleteTempRole ? null : current.maintenanceTempRoleId,
        shouldDeleteTempRole: false,
        maintenanceBypassRoleId: current.shouldDeleteBypassRole ? null : current.maintenanceBypassRoleId,
        shouldDeleteBypassRole: false,
        memberRoleSnapshots: {},
        channelPermissionSnapshots: {},
        roleChannelSnapshots: {},
        everyoneViewPermission: null,
        timeoutAt: null,
        timeoutSetBy: null,
        logs: this.trimLogs(logs),
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

      const tempRole = current.maintenanceTempRoleId
        ? guild.roles.cache.get(current.maintenanceTempRoleId) || (await guild.roles.fetch(current.maintenanceTempRoleId).catch(() => null))
        : null;
      const bypassRole = current.maintenanceBypassRoleId
        ? guild.roles.cache.get(current.maintenanceBypassRoleId) || (await guild.roles.fetch(current.maintenanceBypassRoleId).catch(() => null))
        : null;

      const { channel, created } = await this.findOrCreateMaintenanceChannel(guild, current, {
        tempRole,
        bypassRole,
      });

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
