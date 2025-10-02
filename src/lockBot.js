const {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { randomUUID } = require('node:crypto');
const { StateManager } = require('./stateManager');
const MaintenanceManager = require('./maintenanceManager');

function createLockBot({
  token,
  maintenanceChannelName = 'maintenance',
  stateFile,
  intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  logger = console,
} = {}) {
  if (!token) {
    throw new Error('A Discord bot token is required to create LockBot.');
  }

  const client = new Client({ intents });
  const stateManager = new StateManager(stateFile);
  const maintenanceManager = new MaintenanceManager(stateManager, {
    maintenanceChannelName,
  });

  const MAINTENANCE_STATUS_BUTTON_ID = 'maintenance_status';
  const MAINTENANCE_HELP_BUTTON_ID = 'maintenance_help';
  const MAINTENANCE_CONFIRM_PREFIX = 'maintenance_confirm:';
  const MAINTENANCE_CANCEL_PREFIX = 'maintenance_cancel:';
  const PENDING_ACTION_TTL_MS = 2 * 60 * 1000;
  const CONFIRMATION_PROMPT_MINUTES = Math.max(1, Math.round(PENDING_ACTION_TTL_MS / 60000));

  const EMBED_COLORS = {
    warning: 0xffc857,
    info: 0x5865f2,
    success: 0x57f287,
    danger: 0xed4245,
  };

  const HELP_RESPONSES = [
    "We're tuning things up! Thanks for sticking with us.",
    "Almost there—feel free to grab a coffee while we finish.",
    "We're double-checking everything so you have a smoother experience soon.",
    "Maintenance keeps the gears running smoothly. Thanks for your patience!",
    "Hang tight! The admins are working to bring everything back online safely.",
  ];

  const logWarn =
    typeof logger.warn === 'function'
      ? (...args) => logger.warn(...args)
      : (...args) => logger.info(...args);

  const stateCache = new Map();

  const autoDisableTimers = new Map();

  const pendingActions = new Map();

  function pickHelpResponse() {
    return HELP_RESPONSES[Math.floor(Math.random() * HELP_RESPONSES.length)];
  }

  function buildMaintenanceEmbed({ title, description, color = EMBED_COLORS.info, fields = [], footer }) {
    const embed = new EmbedBuilder().setColor(color).setTimestamp();

    if (title) {
      embed.setTitle(title);
    }

    if (description) {
      embed.setDescription(description);
    }

    if (Array.isArray(fields) && fields.length > 0) {
      embed.addFields(fields);
    }

    if (footer?.text) {
      embed.setFooter({ text: footer.text });
    }

    return embed;
  }

  function buildMaintenanceActionRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(MAINTENANCE_STATUS_BUTTON_ID)
        .setLabel('Get Status')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📊'),
      new ButtonBuilder()
        .setCustomId(MAINTENANCE_HELP_BUTTON_ID)
        .setLabel('Need Help?')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('💬')
    );
  }

  function registerPendingAction(record) {
    const action = { ...record, createdAt: Date.now() };
    action.timeoutHandle = setTimeout(() => {
      const stored = pendingActions.get(action.id);
      if (stored && stored === action) {
        pendingActions.delete(action.id);
      }
    }, PENDING_ACTION_TTL_MS);
    pendingActions.set(action.id, action);
    return action;
  }

  function getPendingAction(id) {
    return pendingActions.get(id) ?? null;
  }

  function removePendingAction(id) {
    const action = pendingActions.get(id);
    if (!action) {
      return null;
    }
    if (action.timeoutHandle) {
      clearTimeout(action.timeoutHandle);
    }
    pendingActions.delete(id);
    return action;
  }

  function normalizeReplyPayload(payload) {
    if (typeof payload === 'string') {
      return { content: payload };
    }

    if (!payload || typeof payload !== 'object') {
      return { content: '\u200b' };
    }

    return { ...payload };
  }

  function applyEphemeralFlags(payload, ephemeral) {
    if (!ephemeral) {
      return payload;
    }

    return {
      ...payload,
      flags: typeof payload.flags === 'number' ? payload.flags | MessageFlags.Ephemeral : MessageFlags.Ephemeral,
    };
  }

  async function safeReply(interaction, payload, { ephemeral = true } = {}) {
    const normalizedBase = normalizeReplyPayload(payload);
    const normalized = applyEphemeralFlags(normalizedBase, ephemeral);
    delete normalized.ephemeral;

    if (!normalized.content && !normalized.embeds && !normalized.components && !normalized.files) {
      normalized.content = '\u200b';
    }

    try {
      if (interaction.deferred || interaction.replied) {
        const editablePayload = { ...normalized };
        delete editablePayload.flags;
        await interaction.editReply(editablePayload);
        return;
      }

      await interaction.reply(normalized);
    } catch (error) {
      if (error?.code === 10008) {
        try {
          const followPayload = { ...normalized };
          await interaction.followUp(followPayload);
        } catch (followError) {
          logger.error('Failed to send follow-up after edit failure', followError);
        }
        return;
      }

      throw error;
    }
  }

  async function safeFollowUp(interaction, payload, { ephemeral = true } = {}) {
    const normalized = applyEphemeralFlags(normalizeReplyPayload(payload), ephemeral);
    delete normalized.ephemeral;

    if (!normalized.content && !normalized.embeds && !normalized.components && !normalized.files) {
      normalized.content = '\u200b';
    }

    try {
      await interaction.followUp(normalized);
    } catch (error) {
      if (error?.code !== 10008) {
        throw error;
      }
    }
  }

  function buildStatusEmbed(guild, state) {
    const description = state.enabled
      ? 'The server is currently in maintenance mode. Only administrators have full access.'
      : 'Maintenance mode is disabled and the server is fully accessible.';

    const fields = [];

    if (state.maintenanceChannelId) {
      fields.push({
        name: 'Maintenance Channel',
        value: `<#${state.maintenanceChannelId}>`,
        inline: true,
      });
    }

    if (state.memberRoleSnapshots) {
      const lockedCount = Object.keys(state.memberRoleSnapshots).length;
      fields.push({
        name: 'Members Restricted',
        value: `${lockedCount}`,
        inline: true,
      });
    }

    if (state.maintenanceTempRoleId) {
      fields.push({
        name: 'Temporary Role',
        value: `<@&${state.maintenanceTempRoleId}>`,
        inline: true,
      });
    }

    if (state.maintenanceBypassRoleId) {
      fields.push({
        name: 'Bypass Role',
        value: `<@&${state.maintenanceBypassRoleId}>`,
        inline: true,
      });
    }

    if (state.timeoutAt) {
      const timeoutUnix = Math.floor(new Date(state.timeoutAt).getTime() / 1000);
      const timeoutSetBy = state.timeoutSetBy ? ` (set by <@${state.timeoutSetBy}>)` : '';
      fields.push({
        name: 'Scheduled Restore',
        value: `<t:${timeoutUnix}:f> (<t:${timeoutUnix}:R>)${timeoutSetBy}`,
        inline: true,
      });
    } else {
      fields.push({
        name: 'Scheduled Restore',
        value: 'Not scheduled',
        inline: true,
      });
    }

    if (state.lastAnnouncement?.timestamp) {
      const lastUnix = Math.floor(new Date(state.lastAnnouncement.timestamp).getTime() / 1000);
      let summary = state.lastAnnouncement.title
        ? `**${state.lastAnnouncement.title}**`
        : state.lastAnnouncement.content ?? '—';

      if (summary.length > 900) {
        summary = `${summary.slice(0, 897)}…`;
      }

      const author = state.lastAnnouncement.authorId ? ` by <@${state.lastAnnouncement.authorId}>` : '';
      fields.push({
        name: 'Last Update',
        value: `${summary}
<t:${lastUnix}:R>${author}`,
        inline: false,
      });
    }

    return buildMaintenanceEmbed({
      title: 'Maintenance Status',
      description,
      color: state.enabled ? EMBED_COLORS.warning : EMBED_COLORS.success,
      fields,
      footer: { text: guild.name },
    });
  }

  async function performMaintenanceEnable({ guild, requestedById, durationMinutes }) {
    let timeoutAt = null;
    let timeoutSetBy = null;

    if (durationMinutes) {
      const durationMs = durationMinutes * 60 * 1000;
      timeoutAt = new Date(Date.now() + durationMs).toISOString();
      timeoutSetBy = requestedById;
    }

    let state = await maintenanceManager.enable(guild, { timeoutAt, timeoutSetBy });
    stateCache.set(guild.id, state);
    scheduleAutoDisable(guild, state);

    const timeoutUnix = timeoutAt ? Math.floor(new Date(timeoutAt).getTime() / 1000) : null;

    const lockedCount = Object.keys(state.memberRoleSnapshots || {}).length;

    const fields = [
      { name: 'Triggered by', value: `<@${requestedById}>`, inline: true },
      {
        name: 'Members Locked',
        value: `${lockedCount}`,
        inline: true,
      },
      {
        name: 'Scheduled Restore',
        value: timeoutUnix
          ? `<t:${timeoutUnix}:f> (<t:${timeoutUnix}:R>)`
          : 'Not scheduled',
        inline: true,
      },
    ];

    const embed = buildMaintenanceEmbed({
      title: 'Maintenance Mode Enabled',
      description:
        'Non-administrator members are restricted to this channel while maintenance is underway.',
      color: EMBED_COLORS.warning,
      fields,
      footer: { text: guild.name },
    });

    const components = [buildMaintenanceActionRow()];

    state = await maintenanceManager.sendAnnouncement(guild, {
      authorId: requestedById,
      embed,
      components,
    });
    stateCache.set(guild.id, state);
    scheduleAutoDisable(guild, state);

    let reply = `Maintenance mode enabled. Locked ${lockedCount} member${lockedCount === 1 ? '' : 's'} to the maintenance role.`;
    if (timeoutUnix) {
      reply += ` Auto-disable scheduled for <t:${timeoutUnix}:f> (<t:${timeoutUnix}:R>).`;
    }

    return { state, timeoutAt, reply };
  }

  async function performMaintenanceDisable({ guild, requestedById }) {
    const stateBeforeDisable = stateCache.get(guild.id) ?? (await refreshGuildState(guild.id));

    if (stateBeforeDisable.enabled && !stateBeforeDisable.shouldDeleteMaintenanceChannel) {
      try {
        const embed = buildMaintenanceEmbed({
          title: 'Maintenance Complete',
          description: 'The maintenance window has ended. Restoring normal access now.',
          color: EMBED_COLORS.success,
          footer: { text: guild.name },
        });

        const components = [buildMaintenanceActionRow()];

        const updatedState = await maintenanceManager.sendAnnouncement(guild, {
          authorId: requestedById,
          embed,
          components,
        });
        stateCache.set(guild.id, updatedState);
      } catch (error) {
        logWarn('Failed to send maintenance completion embed before disabling', error);
      }
    }

    const state = await maintenanceManager.disable(guild);
    clearAutoDisable(guild.id);
    stateCache.set(guild.id, state);

    const expectedRestoreCount = Object.keys(stateBeforeDisable.memberRoleSnapshots || {}).length;
    const reply = `Maintenance mode disabled. Restored up to ${expectedRestoreCount} member${expectedRestoreCount === 1 ? '' : 's'}.`;

    return { state, reply };
  }

  function clearAutoDisable(guildId) {
    const handle = autoDisableTimers.get(guildId);
    if (handle) {
      clearTimeout(handle);
      autoDisableTimers.delete(guildId);
    }
  }

  async function handleAutoDisable(guildId) {
    clearAutoDisable(guildId);

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return;
    }

    const currentState = stateCache.get(guildId) ?? (await refreshGuildState(guildId));
    if (!currentState.enabled) {
      return;
    }

    try {
      try {
        const embed = buildMaintenanceEmbed({
          title: 'Maintenance Window Complete',
          description: 'Maintenance finished automatically. Restoring access for everyone.',
          color: EMBED_COLORS.success,
          footer: { text: guild.name },
        });

        const updatedState = await maintenanceManager.sendAnnouncement(guild, { embed });
        stateCache.set(guildId, updatedState);
      } catch (sendError) {
        logWarn(`Failed to notify maintenance channel during auto-disable for guild ${guildId}`, sendError);
      }

      const state = await maintenanceManager.disable(guild);
      stateCache.set(guildId, state);
      logger.info(`Maintenance auto-disabled for guild ${guildId}`);
    } catch (error) {
      logger.error(`Failed to auto-disable maintenance for guild ${guildId}`, error);
    }
  }

  function scheduleAutoDisable(guild, state) {
    clearAutoDisable(guild.id);

    if (!state?.enabled || !state.timeoutAt) {
      return;
    }

    const timeoutDate = new Date(state.timeoutAt);
    if (Number.isNaN(timeoutDate.getTime())) {
      logWarn(`Invalid maintenance timeout for guild ${guild.id}: ${state.timeoutAt}`);
      return;
    }

    const delay = timeoutDate.getTime() - Date.now();
    if (delay <= 0) {
      handleAutoDisable(guild.id).catch((error) =>
        logger.error(`Failed immediate auto-disable for guild ${guild.id}`, error)
      );
      return;
    }

    const handle = setTimeout(() => {
      handleAutoDisable(guild.id).catch((error) => {
        logger.error(`Failed timed auto-disable for guild ${guild.id}`, error);
      });
    }, delay);

    autoDisableTimers.set(guild.id, handle);
  }

  async function refreshGuildState(guildId) {
    const state = await stateManager.getGuildState(guildId);
    stateCache.set(guildId, state);
    return state;
  }

  async function ensureMaintenanceChannel(guild) {
    const state = stateCache.get(guild.id) ?? (await refreshGuildState(guild.id));
    if (!state.enabled) {
      clearAutoDisable(guild.id);
      return;
    }

    try {
      const { channel, created } = await maintenanceManager.findOrCreateMaintenanceChannel(guild, state);

      if (!channel) {
        return;
      }

      if (state.maintenanceChannelId !== channel.id || (created && !state.shouldDeleteMaintenanceChannel)) {
        const updatedState = await stateManager.setGuildState(guild.id, {
          ...state,
          maintenanceChannelId: channel.id,
          shouldDeleteMaintenanceChannel: state.shouldDeleteMaintenanceChannel || created,
        });
        stateCache.set(guild.id, updatedState);
      }
    } catch (error) {
      logger.error(`Failed to ensure maintenance channel for guild ${guild.id}`, error);
    }

    const finalState = stateCache.get(guild.id) ?? state;
    scheduleAutoDisable(guild, finalState);
  }

  client.once(Events.ClientReady, async (c) => {
    logger.info(`Ready! Logged in as ${c.user.tag}`);

    for (const guild of client.guilds.cache.values()) {
      await ensureMaintenanceChannel(guild);
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    await ensureMaintenanceChannel(guild);
  });

  client.on(Events.GuildDelete, async (guild) => {
    stateCache.delete(guild.id);
    clearAutoDisable(guild.id);

    for (const [id, action] of pendingActions.entries()) {
      if (action.guildId === guild.id) {
        if (action.timeoutHandle) {
          clearTimeout(action.timeoutHandle);
        }
        pendingActions.delete(id);
      }
    }

    await stateManager.deleteGuildState(guild.id);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      const { customId } = interaction;

      if (customId.startsWith(MAINTENANCE_CONFIRM_PREFIX) || customId.startsWith(MAINTENANCE_CANCEL_PREFIX)) {
        const guild = interaction.guild;
        const guildName = guild?.name ?? 'Maintenance';
        const baseId = customId.startsWith(MAINTENANCE_CONFIRM_PREFIX)
          ? customId.slice(MAINTENANCE_CONFIRM_PREFIX.length)
          : customId.slice(MAINTENANCE_CANCEL_PREFIX.length);

        const action = getPendingAction(baseId);

        if (!guild || !action || action.guildId !== guild.id) {
          const embed = buildMaintenanceEmbed({
            title: 'Request Expired',
            description: 'This maintenance request is no longer available. Please run the command again.',
            color: EMBED_COLORS.info,
            footer: { text: guildName },
          });
          await interaction.update({ embeds: [embed], components: [] }).catch(() => {});
          return;
        }

        if (interaction.user.id !== action.userId) {
          await safeReply(interaction, {
            content: `Only <@${action.userId}> can confirm this action.`,
          }).catch(() => {});
          return;
        }

        if (customId.startsWith(MAINTENANCE_CANCEL_PREFIX)) {
          removePendingAction(baseId);
          const embed = buildMaintenanceEmbed({
            title: 'Action Cancelled',
            description: 'No changes were made.',
            color: EMBED_COLORS.info,
            footer: { text: guild.name },
          });
          await interaction.update({ embeds: [embed], components: [] }).catch(() => {});
          return;
        }

        const stored = removePendingAction(baseId);
        if (!stored) {
          const embed = buildMaintenanceEmbed({
            title: 'Request Expired',
            description: 'This maintenance request is no longer available. Please run the command again.',
            color: EMBED_COLORS.info,
            footer: { text: guildName },
          });
          await interaction.update({ embeds: [embed], components: [] }).catch(() => {});
          return;
        }

        const processingEmbed = buildMaintenanceEmbed({
          title: stored.type === 'enable' ? 'Enabling Maintenance' : 'Disabling Maintenance',
          description: 'Hang tight while we update permissions.',
          color: EMBED_COLORS.info,
          footer: { text: guild.name },
        });

        await interaction.update({ embeds: [processingEmbed], components: [] }).catch(() => {});

        try {
          if (stored.type === 'enable') {
            const result = await performMaintenanceEnable({
              guild,
              requestedById: stored.userId,
              durationMinutes: stored.durationMinutes ?? null,
            });

            try {
              const embed = buildMaintenanceEmbed({
                title: 'Maintenance Enabled',
                description: 'Maintenance mode is now active.',
                color: EMBED_COLORS.warning,
                footer: { text: guild.name },
              });
              await interaction.editReply({ embeds: [embed], components: [] });
            } catch (editError) {
              if (editError?.code !== 10008) {
                logWarn('Failed to update confirmation message after enabling maintenance', editError);
              }
            }

            await safeFollowUp(interaction, { content: result.reply }).catch(() => {});
          } else {
            const result = await performMaintenanceDisable({ guild, requestedById: stored.userId });

            try {
              const embed = buildMaintenanceEmbed({
                title: 'Maintenance Disabled',
                description: 'Maintenance mode has been turned off.',
                color: EMBED_COLORS.success,
                footer: { text: guild.name },
              });
              await interaction.editReply({ embeds: [embed], components: [] });
            } catch (editError) {
              if (editError?.code !== 10008) {
                logWarn('Failed to update confirmation message after disabling maintenance', editError);
              }
            }

            await safeFollowUp(interaction, { content: result.reply }).catch(() => {});
          }
        } catch (error) {
          logger.error('Failed to perform maintenance action', error);
          await safeFollowUp(interaction, {
            content: 'Failed to apply maintenance changes. Check the bot logs.',
          }).catch(() => {});
        }

        return;
      }

      if (![MAINTENANCE_STATUS_BUTTON_ID, MAINTENANCE_HELP_BUTTON_ID].includes(customId)) {
        return;
      }

      const guild = interaction.guild;
      if (!guild) {
        await safeReply(interaction, { content: 'This interaction only works inside a server.' }).catch(() => {});
        return;
      }

      const state = stateCache.get(guild.id) ?? (await refreshGuildState(guild.id));

      if (customId === MAINTENANCE_STATUS_BUTTON_ID) {
        const embed = buildStatusEmbed(guild, state);
        await safeReply(interaction, { embeds: [embed] });
        return;
      }

      if (customId === MAINTENANCE_HELP_BUTTON_ID) {
        const embed = buildMaintenanceEmbed({
          title: 'Thanks for checking in!',
          description: `${pickHelpResponse()}

If you need urgent help, reach out to an administrator.`,
          color: EMBED_COLORS.info,
          footer: { text: guild.name },
        });
        await safeReply(interaction, { embeds: [embed] });
        return;
      }

      return;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== 'maintenance') {
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const memberPermissions = interaction.memberPermissions;
    const isAdmin = memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isAdmin && subcommand !== 'status') {
      await safeReply(interaction, {
        content: 'You need administrator permissions to manage maintenance mode.',
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {

      if (subcommand === 'enable') {
        const durationMinutes = interaction.options.getInteger('duration_minutes');
        const baseId = randomUUID();

        registerPendingAction({
          id: baseId,
          type: 'enable',
          guildId: guild.id,
          userId: interaction.user.id,
          durationMinutes: durationMinutes ?? null,
        });

        const autoDisableLabel = durationMinutes
          ? `${durationMinutes} minute${durationMinutes === 1 ? '' : 's'} after confirmation`
          : 'Not scheduled';
        const expiryLabel = `Prompt expires in ${CONFIRMATION_PROMPT_MINUTES} minute${CONFIRMATION_PROMPT_MINUTES === 1 ? '' : 's'}.`;

        const fields = [
          { name: 'Requested by', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Auto-disable', value: autoDisableLabel, inline: true },
          { name: 'Expires', value: expiryLabel, inline: true },
        ];

        const embed = buildMaintenanceEmbed({
          title: 'Confirm Maintenance Enable',
          description:
            'Enable maintenance mode? Non-admin members will be limited to the maintenance channel.',
          color: EMBED_COLORS.warning,
          fields,
          footer: { text: guild.name },
        });

        const components = [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${MAINTENANCE_CONFIRM_PREFIX}${baseId}`)
              .setLabel('Enable Maintenance')
              .setStyle(ButtonStyle.Danger)
              .setEmoji('⚠️'),
            new ButtonBuilder()
              .setCustomId(`${MAINTENANCE_CANCEL_PREFIX}${baseId}`)
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('✖️')
          ),
        ];

        await safeReply(interaction, { embeds: [embed], components });
      } else if (subcommand === 'disable') {
        const baseId = randomUUID();

        registerPendingAction({
          id: baseId,
          type: 'disable',
          guildId: guild.id,
          userId: interaction.user.id,
        });

        const expiryLabel = `Prompt expires in ${CONFIRMATION_PROMPT_MINUTES} minute${CONFIRMATION_PROMPT_MINUTES === 1 ? '' : 's'}.`;

        const fields = [
          { name: 'Requested by', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Effect', value: 'Restores channel visibility for non-admin roles.', inline: true },
          { name: 'Expires', value: expiryLabel, inline: true },
        ];

        const embed = buildMaintenanceEmbed({
          title: 'Confirm Maintenance Disable',
          description: 'Disable maintenance mode and restore access to the rest of the server?',
          color: EMBED_COLORS.success,
          fields,
          footer: { text: guild.name },
        });

        const components = [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${MAINTENANCE_CONFIRM_PREFIX}${baseId}`)
              .setLabel('Disable Maintenance')
              .setStyle(ButtonStyle.Success)
              .setEmoji('✅'),
            new ButtonBuilder()
              .setCustomId(`${MAINTENANCE_CANCEL_PREFIX}${baseId}`)
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('✖️')
          ),
        ];

        await safeReply(interaction, { embeds: [embed], components });
      } else if (subcommand === 'status') {
        const state = stateCache.get(guild.id) ?? (await refreshGuildState(guild.id));
        const embed = buildStatusEmbed(guild, state);
        await safeReply(interaction, { embeds: [embed] });
      } else if (subcommand === 'message') {
        const messageContent = interaction.options.getString('content', true).trim();
        const state = stateCache.get(guild.id) ?? (await refreshGuildState(guild.id));

        if (!state.enabled) {
          await safeReply(interaction, 'Maintenance mode is not enabled. Enable it before sending messages.');
          return;
        }

        if (!messageContent) {
          await safeReply(interaction, 'Please provide a message to post.');
          return;
        }

        if (messageContent.length > 4000) {
          await safeReply(interaction, 'Maintenance updates must be 4000 characters or fewer.');
          return;
        }

        const embed = buildMaintenanceEmbed({
          title: 'Maintenance Update',
          description: messageContent,
          color: EMBED_COLORS.info,
          fields: [
            { name: 'From', value: `<@${interaction.user.id}>`, inline: true },
          ],
          footer: { text: guild.name },
        });

        const updatedState = await maintenanceManager.sendAnnouncement(guild, {
          authorId: interaction.user.id,
          embed,
          components: [buildMaintenanceActionRow()],
        });
        stateCache.set(guild.id, updatedState);
        scheduleAutoDisable(guild, updatedState);

        await safeReply(interaction, 'Message posted to the maintenance channel.');
      } else {
        await safeReply(interaction, 'Unknown maintenance command.');
      }
    } catch (error) {
      logger.error('Error handling maintenance command', error);
      await safeReply(interaction, 'An error occurred while processing the maintenance command. Check the bot logs.');
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const state = stateCache.get(member.guild.id) ?? (await refreshGuildState(member.guild.id));

    if (state.enabled && state.maintenanceTempRoleId) {
      try {
        await member.roles.add(state.maintenanceTempRoleId, 'Maintenance mode active');
      } catch (error) {
        logger.error(`Failed to assign maintenance temp role to ${member.user.tag}`, error);
      }
    }

    const targetChannelId = state.enabled
      ? state.maintenanceChannelId
      : member.guild.systemChannelId;

    if (!targetChannelId) {
      return;
    }

    const channel =
      member.guild.channels.cache.get(targetChannelId) || (await member.guild.channels.fetch(targetChannelId).catch(() => null));

    if (!channel || !channel.isTextBased()) {
      return;
    }

    const embed = state.enabled
      ? buildMaintenanceEmbed({
          title: 'Server Under Maintenance',
          description: `Hey ${member}, the server is getting a tune-up right now. Thanks for your patience!`,
          color: EMBED_COLORS.warning,
          footer: { text: member.guild.name },
        })
      : buildMaintenanceEmbed({
          title: 'Welcome!',
          description: `We're glad you're here, ${member}. Enjoy your stay!`,
          color: EMBED_COLORS.success,
          footer: { text: member.guild.name },
        });

    try {
      await channel.send({ embeds: [embed] });
    } catch (error) {
      logger.error('Failed to send welcome message', error);
    }
  });

  async function login() {
    return client.login(token);
  }

  async function destroy() {
    for (const handle of autoDisableTimers.values()) {
      clearTimeout(handle);
    }
    autoDisableTimers.clear();

    for (const action of pendingActions.values()) {
      if (action.timeoutHandle) {
        clearTimeout(action.timeoutHandle);
      }
    }
    pendingActions.clear();

    stateCache.clear();
    await client.destroy();
  }

  return {
    client,
    stateManager,
    maintenanceManager,
    login,
    destroy,
    refreshGuildState,
  };
}

module.exports = {
  createLockBot,
};
