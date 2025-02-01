const { SlashCommandBuilder } = require('discord.js');

// Store game types for autocomplete
const GAME_TYPES = ['mines', 'roulette'];

async function getGameLimits(db, game) {
    try {
        const limitsDoc = await db.collection('config').doc('gameLimits').get();
        if (limitsDoc.exists) {
            const limits = limitsDoc.data()[game];
            if (limits) {
                return limits;
            }
        }
        
        // Default limits if none are set
        switch (game) {
            case 'mines':
                return { min: 5, max: 50 }; // Increased minimum bet
            case 'roulette':
                return { min: 5, max: 100 }; // Default roulette limits
            default:
                return { min: 1, max: 100 };
        }
    } catch (error) {
        console.error('Error getting game limits:', error);
        return { min: 1, max: 100 }; // Default fallback
    }
}

async function checkBetLimits(db, gameType, bet) {
    const limits = await getGameLimits(db, gameType);
    if (!limits) return true; // If no limits set, allow all bets
    return bet >= limits.min && bet <= limits.max;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rlimits')
        .setDescription('Set betting limits for games')
        .setDefaultMemberPermissions('8') // Admin only
        .addStringOption(option =>
            option.setName('game')
                .setDescription('The game to set limits for')
                .setRequired(true)
                .addChoices(...GAME_TYPES.map(game => ({ name: game, value: game }))))
        .addIntegerOption(option =>
            option.setName('min')
                .setDescription('Minimum bet amount')
                .setRequired(true)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('max')
                .setDescription('Maximum bet amount')
                .setRequired(true)
                .setMinValue(1)),

    async execute(interaction, db) {
        const game = interaction.options.getString('game');
        const min = interaction.options.getInteger('min');
        const max = interaction.options.getInteger('max');

        if (min > max) {
            return await interaction.reply({
                content: 'Minimum bet cannot be greater than maximum bet!',
                ephemeral: true
            });
        }

        // Update limits in database
        await db.collection('config').doc('gameLimits').set({
            [game]: { min, max }
        }, { merge: true });

        await interaction.reply({
            content: `✅ Betting limits for ${game} set:\nMinimum: ${min} points\nMaximum: ${max} points`,
            ephemeral: false
        });
    },

    getGameLimits,
    checkBetLimits
}; 