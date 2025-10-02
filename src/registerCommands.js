require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID || null;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and CLIENT_ID must be provided in the environment.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('maintenance')
    .setDescription('Server maintenance controls')
        .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('Enable maintenance mode')
        .addIntegerOption((option) =>
          option
            .setName('duration_minutes')
            .setDescription('Automatically disable maintenance after this many minutes')
            .setMinValue(1)
            .setMaxValue(10080)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('disable').setDescription('Disable maintenance mode')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('Show maintenance mode status')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('message')
        .setDescription('Send an update to the maintenance channel')
        .addStringOption((option) =>
          option
            .setName('content')
            .setDescription('Message to post')
            .setRequired(true)
            .setMaxLength(2000)
        )
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(token);

async function main() {
  try {
    if (guildId) {
      console.log(`Registering maintenance slash commands for guild ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    } else {
      console.log('Registering maintenance slash commands globally...');
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
    }

    console.log('Slash commands registered successfully.');
  } catch (error) {
    console.error('Failed to register commands:', error);
    process.exitCode = 1;
  }
}

main();
