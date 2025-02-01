const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const admin = require('firebase-admin');
const db = admin.firestore();
let client;
let updateLeaderboardFn = null;

function setClient(discordClient) {
    client = discordClient;
}

function setUpdateLeaderboard(fn) {
    updateLeaderboardFn = fn;
}

// Lottery types and their configurations
const LOTTERY_TYPES = {
    DAILY: {
        name: 'Daily Draw',
        description: '🎟️ **Snoopy\'s Daily Draw**',
        drawInterval: 24 * 60 * 60 * 1000, // 24 hours
        color: 0x4CAF50,
        emoji: '🎟️'
    },
    WEEKLY: {
        name: 'Blu\'s Weekly Jackpot',
        description: '🎰 **Weekly mega prize pool!**',
        drawInterval: 7 * 24 * 60 * 60 * 1000, // 7 days
        color: 0x2196F3,
        emoji: '🎰'
    },
    SPECIAL: {
        name: 'Snoopy\'s Super Special Sweepstakes',
        description: '🌟 **Limited time ONLY!**',
        color: 0x9C27B0,
        emoji: '🌟'
    }
};

// Track lottery message
let lotteryMessage = null;
let lotteryChannel = null;

// Lottery management commands
async function getCurrencyName() {
    const settingsDoc = await db.collection('config').doc('settings').get();
    return settingsDoc.exists ? settingsDoc.data().currencyName || 'points' : 'points';
}

async function handleSetLottoCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: true });
        return;
    }

    try {
        const type = interaction.options.getString('type');
        const ticketPrice = interaction.options.getInteger('ticket_price');
        const startingJackpot = interaction.options.getInteger('starting_jackpot') || 10;
        const maxTickets = interaction.options.getInteger('max_tickets');
        const winnerCount = interaction.options.getInteger('winners');
        const duration = interaction.options.getInteger('duration');
        const durationUnit = interaction.options.getString('duration_unit');
        const currencyName = await getCurrencyName();

        // Delete existing lottery message if it exists
        if (lotteryMessage) {
            try {
                // First check if the message still exists by trying to fetch it
                const message = await lotteryChannel.messages.fetch(lotteryMessage.id).catch(() => null);
                if (message) {
                    await message.delete();
                }
                // Clear the reference regardless of whether deletion succeeded
                lotteryMessage = null;
            } catch (error) {
                // Only log if it's not a 'Unknown Message' error
                if (error.code !== 10008) {
                    console.error('Error deleting old lottery message:', error);
                }
            }
        }

        // Calculate end time
        const now = Date.now();
        const durationMs = duration * (durationUnit === 'hours' ? 3600000 : 
                                    durationUnit === 'days' ? 86400000 : 
                                    60000);
        const endTime = now + durationMs;

        // Store lottery configuration
        const lotteryConfig = {
            type,
            ticketPrice,
            jackpot: startingJackpot,
            maxTickets,
            winnerCount,
            startTime: now,
            endTime,
            active: true,
            tickets: [],
            lastUpdate: now,
            // Store duration settings for auto-restart
            duration: {
                value: duration,
                unit: durationUnit
            }
        };

        await db.collection('config').doc('lottery').set({
            current: lotteryConfig
        }, { merge: true });

        // Set up lottery message
        lotteryChannel = interaction.channel;
        const embed = await generateLotteryEmbed(lotteryConfig);
        const components = generateLotteryButtons(lotteryConfig);

        lotteryMessage = await interaction.channel.send({ 
            embeds: [embed], 
            components 
        });

        // Store message reference
        await db.collection('config').doc('lottery').update({
            'current.messageId': lotteryMessage.id,
            'current.channelId': lotteryChannel.id
        });

        // Schedule lottery draw
        scheduleLotteryDraw(lotteryConfig);

        const confirmEmbed = new EmbedBuilder()
            .setColor(LOTTERY_TYPES[type].color)
            .setTitle('🎲 Lottery Created')
            .setDescription(`Successfully created a new ${LOTTERY_TYPES[type].name} lottery!`)
            .addFields(
                { name: 'Ticket Price', value: `${ticketPrice} ${currencyName}`, inline: true },
                { name: 'Starting Jackpot', value: `${startingJackpot} ${currencyName}`, inline: true },
                { name: 'Winners', value: winnerCount.toString(), inline: true },
                { name: 'Duration', value: `${duration} ${durationUnit}`, inline: true },
                { name: 'Max Tickets per User', value: maxTickets.toString(), inline: true }
            );

        await interaction.reply({ embeds: [confirmEmbed], ephemeral: false });

    } catch (error) {
        console.error('Error setting up lottery:', error);
        await interaction.reply({
            content: 'An error occurred while setting up the lottery.',
            ephemeral: false
        });
    }
}

async function handleBuyTicketButton(interaction, ticketCount) {
    try {
        await interaction.deferReply({ ephemeral: true });
        const currencyName = await getCurrencyName();

        const lotteryDoc = await db.collection('config').doc('lottery').get();
        if (!lotteryDoc.exists || !lotteryDoc.data().current || !lotteryDoc.data().current.active) {
            await interaction.editReply('No active lottery found.');
            return;
        }

        const lottery = lotteryDoc.data().current;
        const totalCost = lottery.ticketPrice * ticketCount;

        // Check user's points
        const userDoc = await db.collection('users').doc(interaction.user.id).get();
        if (!userDoc.exists || (userDoc.data().points || 0) < totalCost) {
            await interaction.editReply(`You don't have enough ${currencyName} to purchase these tickets.`);
            return;
        }

        // Check if user has reached max tickets
        const userTickets = lottery.tickets.filter(ticket => ticket.userId === interaction.user.id).length;
        if (userTickets + ticketCount > lottery.maxTickets) {
            await interaction.editReply(`You can only purchase up to ${lottery.maxTickets} tickets. You currently have ${userTickets} tickets.`);
            return;
        }

        // Generate new tickets
        const newTickets = Array(ticketCount).fill().map(() => ({
            userId: interaction.user.id,
            username: interaction.user.username,
            purchaseTime: Date.now(),
            ticketNumber: Math.random().toString(36).substring(2, 15)
        }));

        // Update lottery and user data
        await db.runTransaction(async (transaction) => {
            // Update user's points
            transaction.update(db.collection('users').doc(interaction.user.id), {
                points: admin.firestore.FieldValue.increment(-totalCost)
            });

            // Update lottery tickets and jackpot
            // Add 90% of ticket cost to jackpot
            const jackpotIncrease = Math.floor(totalCost * 0.9);
            transaction.update(db.collection('config').doc('lottery'), {
                'current.tickets': admin.firestore.FieldValue.arrayUnion(...newTickets),
                'current.lastUpdate': Date.now(),
                'current.jackpot': admin.firestore.FieldValue.increment(jackpotIncrease)
            });
        });

        // Update lottery display
        await updateLotteryDisplay();

        const ticketEmbed = new EmbedBuilder()
            .setColor(LOTTERY_TYPES[lottery.type].color)
            .setTitle('🎟️ Tickets Purchased!')
            .setDescription(`Successfully purchased ${ticketCount} ticket${ticketCount > 1 ? 's' : ''}!`)
            .addFields(
                { name: 'Cost', value: `${totalCost} ${currencyName}`, inline: true },
                { name: 'Ticket Numbers', value: newTickets.map(t => `\`${t.ticketNumber}\``).join('\n'), inline: true }
            );

        await interaction.editReply({ embeds: [ticketEmbed] });

    } catch (error) {
        console.error('Error purchasing tickets:', error);
        await interaction.editReply('An error occurred while purchasing tickets.');
    }
}

async function generateLotteryEmbed(lottery) {
    const type = LOTTERY_TYPES[lottery.type];
    const timeLeft = lottery.endTime - Date.now();
    const currencyName = await getCurrencyName();

    // Get total tickets sold
    const totalTickets = lottery.tickets ? lottery.tickets.length : 0;
    const uniqueParticipants = new Set(lottery.tickets ? lottery.tickets.map(t => t.userId) : []).size;

    // Calculate odds
    const odds = totalTickets > 0 ? 
        (lottery.winnerCount / totalTickets * 100).toFixed(2) + '%' : 
        'No tickets purchased yet';

    return new EmbedBuilder()
        .setColor(type.color)
        .setTitle(`${type.emoji} ${type.name} Lottery`)
        .setDescription(type.description)
        .addFields(
            { name: '💰 Jackpot', value: `${lottery.jackpot} ${currencyName}`, inline: true },
            { name: '🎟️ Ticket Price', value: `${lottery.ticketPrice} ${currencyName}`, inline: true },
            { name: '👥 Winners', value: lottery.winnerCount.toString(), inline: true },
            { name: '⏰ Time Left', value: `<t:${Math.floor(lottery.endTime / 1000)}:R>`, inline: true },
            { name: '📊 Tickets Sold', value: totalTickets.toString(), inline: true },
            { name: '🎯 Win Chance', value: odds, inline: true },
            { name: '👤 Participants', value: uniqueParticipants.toString(), inline: true },
            { name: '🎫 Max Tickets', value: `${lottery.maxTickets} per user`, inline: true }
        )
        .setFooter({ text: 'Purchase tickets using the buttons below!' })
        .setTimestamp();
}

function generateLotteryButtons(lottery) {
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('lottery_buy_1')
                .setLabel('Buy 1 Ticket')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('1️⃣'),
            new ButtonBuilder()
                .setCustomId('lottery_buy_3')
                .setLabel('Buy 3 Tickets')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('3️⃣'),
            new ButtonBuilder()
                .setCustomId('lottery_buy_5')
                .setLabel('Buy 5 Tickets')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('5️⃣')
        );

    const row2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('lottery_mytickets')
                .setLabel('My Tickets')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🎫'),
            new ButtonBuilder()
                .setCustomId('lottery_winners')
                .setLabel('Past Winners')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🏆')
        );

    return [row1, row2];
}

async function updateLotteryDisplay() {
    try {
        const lotteryDoc = await db.collection('config').doc('lottery').get();
        if (!lotteryDoc.exists || !lotteryDoc.data().current) return;

        const lottery = lotteryDoc.data().current;
        
        // Check if message reference exists
        if (!lotteryMessage && lottery.messageId && lottery.channelId) {
            try {
                const channel = await client.channels.fetch(lottery.channelId);
                lotteryMessage = await channel.messages.fetch(lottery.messageId);
                lotteryChannel = channel;
            } catch (error) {
                console.error('Error fetching lottery message:', error);
                return;
            }
        }

        if (lotteryMessage) {
            const embed = await generateLotteryEmbed(lottery);
            const components = generateLotteryButtons(lottery);
            await lotteryMessage.edit({ embeds: [embed], components });
        }
    } catch (error) {
        console.error('Error updating lottery display:', error);
    }
}

async function scheduleLotteryDraw(lottery) {
    const timeUntilDraw = lottery.endTime - Date.now();
    
    if (timeUntilDraw <= 0) {
        await drawLottery(lottery);
        return;
    }

    setTimeout(async () => {
        await drawLottery(lottery);
    }, timeUntilDraw);
}

async function drawLottery(lottery) {
    try {
        // Get latest lottery data
        const lotteryDoc = await db.collection('config').doc('lottery').get();
        const currentLottery = lotteryDoc.data().current;

        if (!currentLottery || !currentLottery.active) return;

        // Only check for no tickets if we're at or past the end time
        const now = Date.now();
        if (now < currentLottery.endTime) {
            // Reschedule for the actual end time
            scheduleLotteryDraw(currentLottery);
            return;
        }

        const tickets = currentLottery.tickets || [];
        if (tickets.length === 0) {
            // No tickets sold, extend lottery
            await handleNoTickets(currentLottery);
            return;
        }

        // Select winners
        const winners = selectWinners(tickets, currentLottery.winnerCount);
        const prizePerWinner = Math.floor(currentLottery.jackpot / winners.length);

        // Award prizes
        await awardPrizes(winners, prizePerWinner);

        // Update leaderboard
        if (updateLeaderboardFn) {
            updateLeaderboardFn();
        }

        // Store lottery results
        await storeLotteryResults(currentLottery, winners, prizePerWinner);

        // Send winner announcement
        await announceWinners(winners, prizePerWinner, currentLottery);

        // Delete the old lottery message if it exists
        if (lotteryMessage) {
            try {
                await lotteryMessage.delete().catch(() => {});
                lotteryMessage = null;
            } catch (error) {
                console.error('Error deleting lottery message:', error);
            }
        }

        // Deactivate current lottery
        await db.collection('config').doc('lottery').update({
            'current.active': false
        });

        // Start a new lottery with the same settings
        if (lotteryChannel) {
            const now = Date.now();
            const type = currentLottery.type;
            
            // Use stored duration settings or default to type-based duration
            let durationMs;
            if (currentLottery.duration) {
                durationMs = currentLottery.duration.value * 
                    (currentLottery.duration.unit === 'hours' ? 3600000 : 
                     currentLottery.duration.unit === 'days' ? 86400000 : 
                     60000);
            } else {
                durationMs = type === 'DAILY' ? LOTTERY_TYPES.DAILY.drawInterval : 
                            type === 'WEEKLY' ? LOTTERY_TYPES.WEEKLY.drawInterval : 
                            24 * 60 * 60 * 1000;
            }

            const newLotteryConfig = {
                type,
                ticketPrice: currentLottery.ticketPrice,
                jackpot: currentLottery.duration ? 10 : currentLottery.jackpot, // Reset jackpot to 10 for recurring lotteries
                maxTickets: currentLottery.maxTickets,
                winnerCount: currentLottery.winnerCount,
                startTime: now,
                endTime: now + durationMs,
                active: true,
                tickets: [],
                lastUpdate: now,
                // Preserve duration settings
                duration: currentLottery.duration
            };

            await db.collection('config').doc('lottery').set({
                current: newLotteryConfig
            }, { merge: true });

            // Create new lottery message
            const embed = await generateLotteryEmbed(newLotteryConfig);
            const components = generateLotteryButtons(newLotteryConfig);
            
            try {
                lotteryMessage = await lotteryChannel.send({ 
                    embeds: [embed], 
                    components 
                });

                // Store message reference
                await db.collection('config').doc('lottery').update({
                    'current.messageId': lotteryMessage.id,
                    'current.channelId': lotteryChannel.id
                });

                // Schedule next draw
                scheduleLotteryDraw(newLotteryConfig);
            } catch (error) {
                console.error('Error creating new lottery message:', error);
                lotteryMessage = null;
                lotteryChannel = null;
            }
        }

    } catch (error) {
        console.error('Error drawing lottery:', error);
    }
}

function selectWinners(tickets, winnerCount) {
    const shuffled = [...tickets].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(winnerCount, tickets.length));
}

async function awardPrizes(winners, prizePerWinner) {
    const batch = db.batch();
    
    for (const winner of winners) {
        const userRef = db.collection('users').doc(winner.userId);
        batch.update(userRef, {
            points: admin.firestore.FieldValue.increment(prizePerWinner)
        });
    }

    await batch.commit();

    // Update leaderboard
    if (updateLeaderboardFn) {
        updateLeaderboardFn();
    }
}

async function storeLotteryResults(lottery, winners, prizePerWinner) {
    const results = {
        type: lottery.type,
        drawTime: Date.now(),
        totalTickets: lottery.tickets.length,
        jackpot: lottery.jackpot,
        ticketPrice: lottery.ticketPrice,
        winners: winners.map(w => ({
            userId: w.userId,
            username: w.username,
            ticketNumber: w.ticketNumber,
            prize: prizePerWinner
        }))
    };

    await db.collection('lotteryHistory').add(results);
}

async function announceWinners(winners, prizePerWinner, lottery) {
    if (!lotteryChannel) return;
    const currencyName = await getCurrencyName();

    const embed = new EmbedBuilder()
        .setColor(LOTTERY_TYPES[lottery.type].color)
        .setTitle('🎉 Lottery Winners Announced!')
        .setDescription(`Congratulations to our ${winners.length} winner${winners.length > 1 ? 's' : ''}!`)
        .addFields(
            { name: 'Prize per Winner', value: `${prizePerWinner} ${currencyName} 💸`, inline: false },
            { 
                name: 'Winners', 
                value: winners.map(w => 
                    `${w.username} <@${w.userId}> (Ticket: \`${w.ticketNumber}\`)`
                ).join('\n'),
                inline: false 
            }
        )
        .setTimestamp();

    await lotteryChannel.send({ embeds: [embed] });
}

async function handleNoTickets(lottery) {
    if (!lotteryChannel) return;

    // Extend lottery by 24 hours
    const newEndTime = Date.now() + (24 * 60 * 60 * 1000);
    await db.collection('config').doc('lottery').update({
        'current.endTime': newEndTime
    });

    const embed = new EmbedBuilder()
        .setColor(LOTTERY_TYPES[lottery.type].color)
        .setTitle('🎟️ Lottery Extended')
        .setDescription('No tickets were purchased! The lottery has been extended by 24 hours.')
        .setTimestamp();

    await lotteryChannel.send({ embeds: [embed] });
    await updateLotteryDisplay();
}

async function handleMyTicketsButton(interaction) {
    try {
        const currencyName = await getCurrencyName();
        const lotteryDoc = await db.collection('config').doc('lottery').get();
        if (!lotteryDoc.exists || !lotteryDoc.data().current) {
            await interaction.reply({ content: 'No active lottery found.', ephemeral: true });
            return;
        }

        const lottery = lotteryDoc.data().current;
        const userTickets = lottery.tickets.filter(ticket => ticket.userId === interaction.user.id);

        if (userTickets.length === 0) {
            await interaction.reply({ 
                content: 'You haven\'t purchased any tickets for the current lottery!',
                ephemeral: true 
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(LOTTERY_TYPES[lottery.type].color)
            .setTitle('🎫 My Lottery Tickets')
            .setDescription(`You have ${userTickets.length} ticket${userTickets.length > 1 ? 's' : ''} for the current lottery.`)
            .addFields(
                { 
                    name: 'Ticket Numbers', 
                    value: userTickets.map(t => 
                        `\`${t.ticketNumber}\` (Purchased: ${new Date(t.purchaseTime).toLocaleString()})`
                    ).join('\n')
                },
                {
                    name: 'Win Chance',
                    value: `${((userTickets.length / lottery.tickets.length) * 100).toFixed(2)}%`,
                    inline: true
                },
                {
                    name: 'Total Investment',
                    value: `${userTickets.length * lottery.ticketPrice} ${currencyName}`,
                    inline: true
                }
            );

        await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        console.error('Error showing user tickets:', error);
        await interaction.reply({ 
            content: 'An error occurred while fetching your tickets.',
            ephemeral: true 
        });
    }
}

async function handleWinnersButton(interaction) {
    try {
        const currencyName = await getCurrencyName();
        const historySnapshot = await db.collection('lotteryHistory')
            .orderBy('drawTime', 'desc')
            .limit(5)
            .get();

        if (historySnapshot.empty) {
            await interaction.reply({
                content: 'No previous lottery results found!',
                ephemeral: true
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🏆 Recent Lottery Winners')
            .setDescription('Here are the winners from the last 5 lotteries:');

        historySnapshot.docs.forEach(doc => {
            const lottery = doc.data();
            const drawDate = new Date(lottery.drawTime).toLocaleDateString();
            
            embed.addFields({
                name: `${LOTTERY_TYPES[lottery.type].emoji} ${lottery.type} - ${drawDate}`,
                value: lottery.winners.map(w => 
                    `<@${w.userId}> - ${w.prize} ${currencyName}`
                ).join('\n'),
                inline: false
            });
        });

        await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        console.error('Error showing lottery history:', error);
        await interaction.reply({
            content: 'An error occurred while fetching lottery history.',
            ephemeral: true
        });
    }
}

// Add after setClient function
async function restoreActiveLotteries() {
    try {
        const lotteryDoc = await db.collection('config').doc('lottery').get();
        if (!lotteryDoc.exists || !lotteryDoc.data().current || !lotteryDoc.data().current.active) return;

        const lottery = lotteryDoc.data().current;
        
        // Check if the lottery message still exists
        if (lottery.messageId && lottery.channelId) {
            try {
                const channel = await client.channels.fetch(lottery.channelId);
                lotteryChannel = channel;
                lotteryMessage = await channel.messages.fetch(lottery.messageId);
                
                // Reschedule the lottery draw
                scheduleLotteryDraw(lottery);
                
                // Update the display
                await updateLotteryDisplay();
            } catch (error) {
                console.error('Error restoring lottery message:', error);
                // If message is gone, create a new one
                if (lottery.endTime > Date.now()) {
                    lotteryChannel = channel;
                    const embed = await generateLotteryEmbed(lottery);
                    const components = generateLotteryButtons(lottery);
                    lotteryMessage = await channel.send({ 
                        embeds: [embed], 
                        components 
                    });
                    
                    // Update message reference
                    await db.collection('config').doc('lottery').update({
                        'current.messageId': lotteryMessage.id
                    });
                }
            }
        }
    } catch (error) {
        console.error('Error restoring active lotteries:', error);
    }
}

// Add these new functions before the exports
async function handleListLottoCommand(interaction) {
    try {
        // Get current lottery
        const lotteryDoc = await db.collection('config').doc('lottery').get();
        const currentLottery = lotteryDoc.exists ? lotteryDoc.data().current : null;

        // Get past lotteries
        const historySnapshot = await db.collection('lotteryHistory')
            .orderBy('drawTime', 'desc')
            .limit(10)
            .get();

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🎲 Lottery Status')
            .setTimestamp();

        // Add current lottery info if exists
        if (currentLottery && currentLottery.active) {
            const timeLeft = currentLottery.endTime - Date.now();
            const totalTickets = currentLottery.tickets ? currentLottery.tickets.length : 0;
            const currencyName = await getCurrencyName();

            embed.addFields({
                name: '🎯 Current Lottery',
                value: [
                    `**Type:** ${LOTTERY_TYPES[currentLottery.type].name}`,
                    `**Jackpot:** ${currentLottery.jackpot} ${currencyName}`,
                    `**Tickets Sold:** ${totalTickets}`,
                    `**Winners:** ${currentLottery.winnerCount}`,
                    `**Ends:** <t:${Math.floor(currentLottery.endTime / 1000)}:R>`,
                    `**Message:** [Jump to Lottery](https://discord.com/channels/${interaction.guildId}/${currentLottery.channelId}/${currentLottery.messageId})`
                ].join('\n'),
                inline: false
            });
        }

        // Add past lotteries
        if (!historySnapshot.empty) {
            const currencyName = await getCurrencyName();
            embed.addFields({
                name: '📜 Recent Lotteries',
                value: historySnapshot.docs.map(doc => {
                    const lottery = doc.data();
                    const winners = lottery.winners.length;
                    const totalPrize = lottery.winners.reduce((sum, w) => sum + w.prize, 0);
                    return [
                        `**${LOTTERY_TYPES[lottery.type].emoji} ${new Date(lottery.drawTime).toLocaleString()}**`,
                        `Type: ${LOTTERY_TYPES[lottery.type].name}`,
                        `Winners: ${winners} (${totalPrize} ${currencyName} total)`,
                        `Tickets: ${lottery.totalTickets}`
                    ].join('\n');
                }).join('\n\n'),
                inline: false
            });
        }

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error listing lotteries:', error);
        await interaction.reply({
            content: 'An error occurred while listing lotteries.',
            ephemeral: false
        });
    }
}

async function handleRemoveLottoCommand(interaction) {
    try {
        const lotteryId = interaction.options.getString('lottery');
        const lotteryDoc = await db.collection('config').doc('lottery').get();
        const currentLottery = lotteryDoc.exists ? lotteryDoc.data().current : null;

        if (!currentLottery || !currentLottery.active) {
            await interaction.reply({
                content: 'No active lottery found.',
                ephemeral: false
            });
            return;
        }

        // Store lottery info for confirmation message
        const type = currentLottery.type;
        const ticketCount = currentLottery.tickets ? currentLottery.tickets.length : 0;
        const currencyName = await getCurrencyName();

        // Refund all ticket purchases
        if (ticketCount > 0) {
            const batch = db.batch();
            const refunds = new Map();

            currentLottery.tickets.forEach(ticket => {
                const currentRefund = refunds.get(ticket.userId) || 0;
                refunds.set(ticket.userId, currentRefund + currentLottery.ticketPrice);
            });

            for (const [userId, refundAmount] of refunds) {
                const userRef = db.collection('users').doc(userId);
                batch.update(userRef, {
                    points: admin.firestore.FieldValue.increment(refundAmount)
                });
            }

            await batch.commit();
        }

        // Delete the lottery message if it exists
        if (currentLottery.messageId && currentLottery.channelId) {
            try {
                const channel = await client.channels.fetch(currentLottery.channelId);
                const message = await channel.messages.fetch(currentLottery.messageId);
                await message.delete();
            } catch (error) {
                console.error('Error deleting lottery message:', error);
            }
        }

        // Deactivate the lottery
        await db.collection('config').doc('lottery').update({
            'current.active': false
        });

        const embed = new EmbedBuilder()
            .setColor(LOTTERY_TYPES[type].color)
            .setTitle('🗑️ Lottery Removed')
            .setDescription(`Successfully removed the ${LOTTERY_TYPES[type].name} lottery.`)
            .addFields(
                { name: 'Tickets Refunded', value: ticketCount.toString(), inline: true },
                { name: 'Total Refunded', value: `${ticketCount * currentLottery.ticketPrice} ${currencyName}`, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: false });

    } catch (error) {
        console.error('Error removing lottery:', error);
        await interaction.reply({
            content: 'An error occurred while removing the lottery.',
            ephemeral: false
        });
    }
}

async function handleLottoAutocomplete(interaction) {
    try {
        const lotteryDoc = await db.collection('config').doc('lottery').get();
        const currentLottery = lotteryDoc.exists ? lotteryDoc.data().current : null;

        if (!currentLottery || !currentLottery.active) {
            await interaction.respond([]);
            return;
        }

        const choice = {
            name: `${LOTTERY_TYPES[currentLottery.type].name} (Ends ${new Date(currentLottery.endTime).toLocaleString()})`,
            value: 'current'
        };

        await interaction.respond([choice]);
    } catch (error) {
        console.error('Error handling lottery autocomplete:', error);
        await interaction.respond([]);
    }
}

// Update module.exports
module.exports = {
    handleSetLottoCommand,
    handleBuyTicketButton,
    handleMyTicketsButton,
    handleWinnersButton,
    handleListLottoCommand,
    handleRemoveLottoCommand,
    handleLottoAutocomplete,
    updateLotteryDisplay,
    setClient,
    setUpdateLeaderboard,
    restoreActiveLotteries
}; 