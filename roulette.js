const { SlashCommandBuilder } = require('discord.js');
const { EmbedBuilder } = require('discord.js');
const limits = require('./limits.js');
const admin = require('firebase-admin');

let updateLeaderboardFn = null;

function setUpdateLeaderboard(fn) {
    updateLeaderboardFn = fn;
}

// Roulette betting options and their payouts
const ROULETTE_BETS = {
    'red': { payout: 2, numbers: [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36] },
    'black': { payout: 2, numbers: [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35] },
    'green': { payout: 36, numbers: [0] },
    'even': { payout: 2, numbers: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36] },
    'odd': { payout: 2, numbers: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35] },
    '1-12': { payout: 3, numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    '13-24': { payout: 3, numbers: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] },
    '25-36': { payout: 3, numbers: [25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36] },
    '1-18': { payout: 2, numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] },
    '19-36': { payout: 2, numbers: [19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36] }
};

// Get currency name from settings
async function getCurrencyName(db) {
    const settingsDoc = await db.collection('config').doc('settings').get();
    return settingsDoc.exists ? settingsDoc.data().currencyName || 'points' : 'points';
}

// Generate a random roulette number
function spinRoulette() {
    return Math.floor(Math.random() * 37); // 0-36
}

// Check if a bet won
function checkWin(number, betType) {
    return ROULETTE_BETS[betType].numbers.includes(number);
}

// Get the color of a number
function getNumberColor(number) {
    if (number === 0) return '🟢';
    return ROULETTE_BETS.red.numbers.includes(number) ? '🔴' : '⚫';
}

// Create roulette result embed
async function createResultEmbed(number, bet, betType, winAmount, currencyName, username) {
    const color = number === 0 ? 0x2ECC71 : ROULETTE_BETS.red.numbers.includes(number) ? 0xE74C3C : 0x34495E;
    const won = checkWin(number, betType);
    
    return new EmbedBuilder()
        .setColor(color)
        .setTitle('🎰 Roulette Results')
        .setDescription(`${username}'s Spin Results`)
        .addFields(
            { name: 'Number Rolled', value: `${getNumberColor(number)} ${number}`, inline: true },
            { name: 'Your Bet', value: `${bet} ${currencyName} on ${betType}`, inline: true },
            { name: 'Outcome', value: won ? `Won ${winAmount} ${currencyName}! 🎉` : `Lost ${bet} ${currencyName} 😢`, inline: true }
        )
        .setTimestamp();
}

async function execute(interaction, db) {
    const bet = interaction.options.getInteger('bet');
    const betType = interaction.options.getString('choice');
    const userId = interaction.user.id;
    const currencyName = await getCurrencyName(db);

    // Check bet limits
    const withinLimits = await limits.checkBetLimits(db, 'roulette', bet);
    if (!withinLimits) {
        const gameLimits = await limits.getGameLimits(db, 'roulette');
        return await interaction.reply({ 
            content: `Your bet must be between ${gameLimits.min} and ${gameLimits.max} ${currencyName}!`,
            ephemeral: true 
        });
    }

    // Get user's points
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data() || { points: 0 };

    if (userData.points < bet) {
        return await interaction.reply({ 
            content: `You don't have enough ${currencyName} for this bet!`,
            ephemeral: true 
        });
    }

    // Deduct bet amount
    await db.collection('users').doc(userId).update({
        points: admin.firestore.FieldValue.increment(-bet)
    });

    // Spin the roulette and determine outcome
    const number = spinRoulette();
    const won = checkWin(number, betType);
    const winAmount = won ? bet * ROULETTE_BETS[betType].payout : 0;

    // Add winnings if won
    if (won) {
        await db.collection('users').doc(userId).update({
            points: admin.firestore.FieldValue.increment(winAmount)
        });
    }

    // Create and send result embed
    const embed = await createResultEmbed(
        number,
        bet,
        betType,
        winAmount,
        currencyName,
        interaction.user.username
    );

    await interaction.reply({ embeds: [embed] });

    // Update leaderboard
    if (updateLeaderboardFn) {
        updateLeaderboardFn();
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('roulette')
        .setDescription('Play a game of roulette')
        .addIntegerOption(option =>
            option.setName('bet')
                .setDescription('Amount to bet')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('choice')
                .setDescription('What to bet on')
                .setRequired(true)
                .addChoices(
                    { name: 'Red', value: 'red' },
                    { name: 'Black', value: 'black' },
                    { name: 'Green (0)', value: 'green' },
                    { name: 'Even', value: 'even' },
                    { name: 'Odd', value: 'odd' },
                    { name: '1-12', value: '1-12' },
                    { name: '13-24', value: '13-24' },
                    { name: '25-36', value: '25-36' },
                    { name: '1-18', value: '1-18' },
                    { name: '19-36', value: '19-36' }
                )),
    execute,
    setUpdateLeaderboard
}; 