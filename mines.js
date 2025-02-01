const { SlashCommandBuilder } = require('discord.js');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const limits = require('./limits.js');
const admin = require('firebase-admin');

// Store active games and their timeouts
const activeGames = new Map();
const gameTimeouts = new Map();
const TIMEOUT_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

let updateLeaderboardFn = null;

// Add function to get currency name
async function getCurrencyName(db) {
    const settingsDoc = await db.collection('config').doc('settings').get();
    return settingsDoc.exists ? settingsDoc.data().currencyName || 'points' : 'points';
}

// Add function to set updateLeaderboard reference
function setUpdateLeaderboard(fn) {
    updateLeaderboardFn = fn;
}

function clearGameTimeout(userId) {
    const timeout = gameTimeouts.get(userId);
    if (timeout) {
        clearTimeout(timeout);
        gameTimeouts.delete(userId);
    }
}

async function handleGameTimeout(userId, db, game) {
    if (!activeGames.has(userId)) return; // Game already ended

    // Return the bet if they revealed no tiles
    if (game.revealed.size === 0) {
        await db.collection('users').doc(userId).update({
            points: admin.firestore.FieldValue.increment(game.bet)
        });
    }
    
    activeGames.delete(userId);
    gameTimeouts.delete(userId);
}

class MinesGame {
    constructor(bet, userId) {
        this.bet = bet;
        this.userId = userId;
        this.board = this.generateBoard();
        this.revealed = new Set();
        this.gameOver = false;
        this.multiplier = 1.0;
    }

    generateBoard() {
        // Create a 4x4 board
        const board = Array(16).fill('safe');
        // Randomly place 3 mines
        let minesToPlace = 4;
        while (minesToPlace > 0) {
            const pos = Math.floor(Math.random() * 16);
            if (board[pos] === 'safe') {
                board[pos] = 'mine';
                minesToPlace--;
            }
        }
        return board;
    }

    revealTile(position) {
        if (this.gameOver || this.revealed.has(position)) return null;

        this.revealed.add(position);
        const isMine = this.board[position] === 'mine';

        if (isMine) {
            this.gameOver = true;
            return { type: 'mine', multiplier: 0 };
        }

        // Base multiplier increase (even smaller early game, scales up)
        const revealedCount = this.revealed.size;
        const baseIncrease = 0.2 + (revealedCount * 0.05); // Starts at 0.25x, increases by 0.05x per tile
        this.multiplier += baseIncrease;
        
        // Small consecutive bonus (reduced further)
        const consecutiveBonus = Math.min(revealedCount * 0.02, 0.1);
        this.multiplier += consecutiveBonus;

        // Check if won (revealed all safe tiles)
        const safeTilesCount = this.board.filter(tile => tile === 'safe').length;
        if (this.revealed.size === safeTilesCount) {
            this.gameOver = true;
            // Completion bonus (reduced further)
            this.multiplier += 1.0;
        }

        return { 
            type: 'safe', 
            multiplier: Math.round(this.multiplier * 10) / 10, // Round to 1 decimal place
            gameOver: this.gameOver
        };
    }

    generateButtons(currencyName) {
        const rows = [];
        // Create 4x4 grid of mine buttons
        for (let i = 0; i < 4; i++) {
            const row = new ActionRowBuilder();
            for (let j = 0; j < 4; j++) {
                const position = i * 4 + j;
                const button = new ButtonBuilder()
                    .setCustomId(`mines_${position}`)
                    .setLabel('🟦')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(this.revealed.has(position) || this.gameOver);

                if (this.revealed.has(position)) {
                    button.setLabel(this.board[position] === 'mine' ? '💣' : '⭐')
                        .setStyle(this.board[position] === 'mine' ? ButtonStyle.Danger : ButtonStyle.Success);
                }

                row.addComponents(button);
            }
            rows.push(row);
        }

        // Add cash out button as a separate row
        if (!this.gameOver && this.revealed.size > 0) {
            const cashOutAmount = Math.floor(this.bet * this.multiplier);
            const cashOutRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('mines_cashout')
                        .setLabel(`💰 Cash Out (${cashOutAmount} ${currencyName})`)
                        .setStyle(ButtonStyle.Primary)
                );
            rows.push(cashOutRow);
        }

        return rows;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mines')
        .setDescription('Play a game of Mines')
        .addIntegerOption(option =>
            option.setName('bet')
                .setDescription('Amount of points to bet')
                .setRequired(true)
                .setMinValue(1)),

    async execute(interaction, db) {
        const bet = interaction.options.getInteger('bet');
        const userId = interaction.user.id;
        const currencyName = await getCurrencyName(db);

        // Clear any existing timeouts for this user
        clearGameTimeout(userId);

        // Check bet limits
        const withinLimits = await limits.checkBetLimits(db, 'mines', bet);
        if (!withinLimits) {
            const gameLimits = await limits.getGameLimits(db, 'mines');
            return await interaction.reply({ 
                content: `Your bet must be between ${gameLimits.min} and ${gameLimits.max} ${currencyName}!`,
                ephemeral: true 
            });
        }

        // Check if user already has an active game
        if (activeGames.has(userId)) {
            return await interaction.reply({ 
                content: 'You already have an active game! Finish it first.',
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

        // Create new game
        const game = new MinesGame(bet, userId);
        activeGames.set(userId, game);

        // Set timeout for the game
        const timeout = setTimeout(() => handleGameTimeout(userId, db, game), TIMEOUT_DURATION);
        gameTimeouts.set(userId, timeout);

        // Deduct bet amount
        await db.collection('users').doc(userId).update({
            points: userData.points - bet
        });

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('💣 Mines Game')
            .setDescription(`Bet: ${bet} ${currencyName}\nMultiplier: ${game.multiplier}x\n\nClick on tiles to reveal them. Avoid the mines!\n\n⏰ Game will timeout in 5 minutes if inactive.`)
            .addFields(
                { name: 'How to Play', value: 'Click tiles to reveal them. Find safe tiles (⭐) to increase your multiplier. Hit a mine (💣) and you lose!' },
                { name: 'Multipliers', value: '• +0.25x per tile\n• +0.02x bonus per consecutive safe tile\n• +1.0x bonus for clearing all safe tiles!' }
            );

        await interaction.reply({
            embeds: [embed],
            components: game.generateButtons(currencyName)
        });
    },

    async handleButton(interaction, db) {
        const userId = interaction.user.id;
        const game = activeGames.get(userId);
        const currencyName = await getCurrencyName(db);

        if (!game) {
            return await interaction.reply({
                content: 'No active game found! The game may have timed out.',
                ephemeral: true
            });
        }

        // Reset timeout since user is active
        clearGameTimeout(userId);
        const timeout = setTimeout(() => handleGameTimeout(userId, db, game), TIMEOUT_DURATION);
        gameTimeouts.set(userId, timeout);

        if (game.userId !== userId) {
            return await interaction.reply({
                content: 'This is not your game!',
                ephemeral: true
            });
        }

        // Handle cash out
        if (interaction.customId === 'mines_cashout') {
            const winnings = Math.floor(game.bet * game.multiplier);
            activeGames.delete(userId);
            clearGameTimeout(userId);

            // Add winnings to user's points
            await db.collection('users').doc(userId).update({
                points: admin.firestore.FieldValue.increment(winnings)
            });
            
            // Update leaderboard
            if (updateLeaderboardFn) {
                updateLeaderboardFn();
            }

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('💣 Mines Game')
                .setDescription(`💰 Cashed out ${winnings} ${currencyName}! (${game.multiplier.toFixed(1)}x multiplier)`);

            await interaction.update({
                embeds: [embed],
                components: game.generateButtons(currencyName)
            });
            return;
        }

        const position = parseInt(interaction.customId.split('_')[1]);
        const result = game.revealTile(position);

        if (!result) {
            return await interaction.reply({
                content: 'This tile is already revealed!',
                ephemeral: true
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('💣 Mines Game')
            .setDescription(`Bet: ${game.bet} ${currencyName}\nMultiplier: ${result.multiplier.toFixed(1)}x`);

        if (game.gameOver) {
            activeGames.delete(userId);
            clearGameTimeout(userId);

            if (result.type === 'mine') {
                embed.setColor('#ff0000')
                    .setDescription(`💥 BOOM! You hit a mine and lost ${game.bet} ${currencyName}!`);
            } else {
                const winnings = Math.floor(game.bet * result.multiplier);
                embed.setColor('#00ff00')
                    .setDescription(`🎉 You won ${winnings} ${currencyName}! (${result.multiplier.toFixed(1)}x multiplier)`);

                // Add winnings to user's points
                await db.collection('users').doc(userId).update({
                    points: admin.firestore.FieldValue.increment(winnings)
                });
                
                // Update leaderboard
                if (updateLeaderboardFn) {
                    updateLeaderboardFn();
                }
            }
        }

        await interaction.update({
            embeds: [embed],
            components: game.generateButtons(currencyName)
        });
    },

    setUpdateLeaderboard
}; 