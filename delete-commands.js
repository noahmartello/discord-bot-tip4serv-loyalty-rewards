require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST().setToken(process.env.BOT_TOKEN);

// Delete all commands
(async () => {
    try {
        console.log('Started deleting application (/) commands.');

        // Delete all global commands
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: [] }
        );

        console.log('Successfully deleted all application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})(); 