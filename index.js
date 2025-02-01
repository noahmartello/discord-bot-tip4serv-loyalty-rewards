const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const admin = require('firebase-admin');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const CHART_BASE_URL = 'https://quickchart.io/chart';

// Initialize Firebase Admin
const serviceAccount = require('./sdk.json');
let db;

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
} catch (error) {
    console.error('Error initializing Firebase:', error);
}

// Track dynamic leaderboard message
let leaderboardMessage = null;
let leaderboardChannel = null;

// Add near the top with other global variables
let logChannel = null;

// Add these variables at the top with other global variables
let spentboardChannel = null;
let spentboardMessage = null;

// Add after other global variables
const COOLDOWN_DURATION = 30000; // 30 seconds in milliseconds
const gameCommands = ['slide', 'roulette', 'mines'];
const cooldowns = new Map();

// Add cooldown check function
async function checkCooldown(userId, commandName) {
    const now = Date.now();
    const key = `${userId}_${commandName}`;
    const cooldownInfo = cooldowns.get(key);
    console.log(`Checking cooldown for ${key}:`, cooldownInfo); // Debug log

    // Check Firebase for cooldown
    const cooldownDoc = await db.collection('cooldowns').doc(userId).get();
    const dbCooldowns = cooldownDoc.exists ? cooldownDoc.data() : {};
    
    if (dbCooldowns[commandName] && now - dbCooldowns[commandName] < COOLDOWN_DURATION) {
        const timeLeft = (COOLDOWN_DURATION - (now - dbCooldowns[commandName])) / 1000;
        return {
            onCooldown: true,
            timeLeft: timeLeft.toFixed(1)
        };
    }

    // Set new cooldown in both Map and Firebase
    cooldowns.set(key, {
        timestamp: now,
        command: commandName
    });
    
    await db.collection('cooldowns').doc(userId).set({
        [commandName]: now
    }, { merge: true });

    return { onCooldown: false };
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// Add near the top with other imports
const lottery = require('./lottery.js');
const mines = require('./mines.js');
const limits = require('./limits.js');
const roulette = require('./roulette.js');

// Add after client is initialized and before any event handlers
lottery.setClient(client);
lottery.setUpdateLeaderboard(() => updateLeaderboard());
mines.setUpdateLeaderboard(() => updateLeaderboard());
roulette.setUpdateLeaderboard(() => updateLeaderboard());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    // Restore leaderboard channel from Firestore
    try {
        const configDoc = await db.collection('config').doc('leaderboard').get();
        if (configDoc.exists) {
            const data = configDoc.data();
            leaderboardChannel = await client.channels.fetch(data.channelId);
            if (data.messageId) {
                try {
                    leaderboardMessage = await leaderboardChannel.messages.fetch(data.messageId);
                } catch (e) {
                    console.log('Previous leaderboard message not found, will create new one');
                }
            }
            updateLeaderboard();
        }

        // Restore spentboard channel
        const spentboardDoc = await db.collection('config').doc('spentboard').get();
        if (spentboardDoc.exists) {
            const data = spentboardDoc.data();
            spentboardChannel = await client.channels.fetch(data.channelId);
            if (data.messageId) {
                try {
                    spentboardMessage = await spentboardChannel.messages.fetch(data.messageId);
                } catch (e) {
                    console.log('Previous spentboard message not found, will create new one');
                }
            }
            updateSpentboard();
        }

        // Restore log channel from Firestore
        const settingsDoc = await db.collection('config').doc('settings').get();
        if (settingsDoc.exists && settingsDoc.data().logChannelId) {
            try {
                logChannel = await client.channels.fetch(settingsDoc.data().logChannelId);
                console.log('Log channel restored successfully');
            } catch (e) {
                console.log('Could not restore log channel:', e);
            }
        }

        // Restore active lotteries
        await lottery.restoreActiveLotteries();

        // Check for temporary roles that need to be removed
        const tempRolesDoc = await db.collection('config').doc('temporaryRoles').get();
        if (tempRolesDoc.exists) {
            const tempRoles = tempRolesDoc.data().roles || [];
            const now = Date.now();

            for (const role of tempRoles) {
                if (role.expiresAt <= now) {
                    // Role has expired, remove it
                    try {
                        const guild = await client.guilds.fetch(role.guildId);
                        const member = await guild.members.fetch(role.userId);
                        await member.roles.remove(role.roleId);
                        await sendRoleExpirationNotification(member, { name: role.roleName }, role.guildId);
                    } catch (error) {
                        console.error(`Error removing expired role: ${error}`);
                    }
                } else {
                    // Role hasn't expired, set up new timeout
                    const timeLeft = role.expiresAt - now;
                    setTimeout(async () => {
                        try {
                            const guild = await client.guilds.fetch(role.guildId);
                            const member = await guild.members.fetch(role.userId);
                            await member.roles.remove(role.roleId);
                            await sendRoleExpirationNotification(member, { name: role.roleName }, role.guildId);
                            // Remove from database
                            const tempRolesDoc = await db.collection('config').doc('temporaryRoles').get();
                            const roles = tempRolesDoc.data().roles || [];
                            await db.collection('config').doc('temporaryRoles').set({
                                roles: roles.filter(r => r.userId !== role.userId || r.roleId !== role.roleId)
                            });
                        } catch (error) {
                            console.error(`Error removing temporary role: ${error}`);
                        }
                    }, timeLeft);
                }
            }

            // Clean up expired roles from database
            await db.collection('config').doc('temporaryRoles').set({
                roles: tempRoles.filter(role => role.expiresAt > now)
            });
        }
    } catch (error) {
        console.error('Error in startup checks:', error);
    }
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    try {
        // Check cooldown for game commands
        if (gameCommands.includes(interaction.commandName)) {
            const cooldownCheck = await checkCooldown(interaction.user.id, interaction.commandName);
            if (cooldownCheck.onCooldown) {
                await interaction.reply({
                    content: `Please wait ${cooldownCheck.timeLeft} seconds before using game commands again.`,
                    ephemeral: true
                });
                return;
            }
        }

        switch (interaction.commandName) {
            case 'rewards':
                await handleRewardsCommand(interaction);
                break;
            case 'purchases':
                await handlePurchasesCommand(interaction);
                break;
            case 'setrole':
                await handleSetRoleCommand(interaction);
                break;
            case 'top':
                await handleTopCommand(interaction);
                break;
            case 'setleaderboard':
                await handleSetLeaderboardCommand(interaction);
                break;
            case 'setimage':
                await handleSetImageCommand(interaction);
                break;
            case 'rgive':
                await handleGivePointsCommand(interaction);
                break;
            case 'rtake':
                await handleTakePointsCommand(interaction);
                break;
            case 'resetpurchase':
                await handleResetPurchaseCommand(interaction);
                break;
            case 'checkpurchases':
                await handleCheckPurchasesCommand(interaction);
                break;
            case 'sales':
                await handleSalesCommand(interaction);
                break;
            case 'bestsellers':
                await handleBestsellersCommand(interaction);
                break;
            case 'revenue':
                await handleRevenueCommand(interaction);
                break;
            case 'multi':
                await handleMultiplierCommand(interaction);
                break;
            case 'multilist':
                await handleMultiListCommand(interaction);
                break;
            case 'multiremove':
                await handleMultiRemoveCommand(interaction);
                break;
            case 'multitier':
                await handleMultiTierCommand(interaction);
                break;
            case 'multitierlist':
                await handleMultiTierListCommand(interaction);
                break;
            case 'shop':
                await handleShopCommand(interaction);
                break;
            case 'p':
                await handleProductCommand(interaction);
                break;
            case 'settier':
                await handleSetTierCommand(interaction);
                break;
            case 'setcur':
                await handleSetCurrencyCommand(interaction);
                break;
            case 'setretention':
                await handleSetRetentionCommand(interaction);
                break;
            case 'setbenefits':
                await handleSetBenefitsCommand(interaction);
                break;
            case 'listbenefits':
                await handleListBenefitsCommand(interaction);
                break;
            case 'setdiscount':
                await handleSetDiscountCommand(interaction);
                break;
            case 'logchan':
                await handleLogChannelCommand(interaction);
                break;
            case 'settings':
                await handleSettingsCommand(interaction);
                break;
            case 'daily':
                await handleDailyCommand(interaction);
                break;
            case 'setdaily':
                await handleSetDailyCommand(interaction);
                break;
            case 'cdreset':
                await handleCooldownResetCommand(interaction);
                break;
            case 'setlotto':
                await lottery.handleSetLottoCommand(interaction);
                break;
            case 'listlotto':
                await lottery.handleListLottoCommand(interaction);
                break;
            case 'removelotto':
                await lottery.handleRemoveLottoCommand(interaction);
                break;
            case 'checkguy':
                await handleCheckGuyCommand(interaction);
                break;
            case 'tierdm':
                await handleTierDMCommand(interaction);
                break;
            case 'dm':
                await handleDMCommand(interaction);
                break;
            case 'settieruser':
                await handleSetTierUserCommand(interaction);
                break;
            case 'mines':
                await mines.execute(interaction, db);
                break;
            case 'roulette':
                await roulette.execute(interaction, db);
                break;
            case 'rlimits':
                await limits.execute(interaction, db);
                break;
            case 'plist':
                await handlePlistCommand(interaction);
                break;
            case 'setspentboard':
                await handleSetSpentboardCommand(interaction);
                break;
            case 'b':
                await handleBCommand(interaction);
                break;
            case 'slide':
                await handleSlideCommand(interaction);
                break;
            case 'setslide':
                await handleSetSlideCommand(interaction);
                break;
            case 'rsetp':
                await handleSetPointsCommand(interaction);
                break;
            case 'resetcooldowns':
                await handleResetCooldownsCommand(interaction);
                break;
        }
    } catch (error) {
        console.error(`Error handling command ${interaction.commandName}:`, error);
        await interaction.reply({ 
            content: 'An error occurred while processing your command.',
            ephemeral: false 
        });
    }
});

// Add this after the interactionCreate event handler for commands
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        // Handle mines game button clicks
        if (interaction.customId.startsWith('mines_')) {
            await mines.handleButton(interaction, db);
            return;
        }
    }

    if (!interaction.isAutocomplete()) return;

    if (interaction.commandName === 'resetpurchase') {
        try {
            const userId = interaction.options.getString('userid');
            if (!userId) {
                console.log('No user ID provided for autocomplete');
                await interaction.respond([]);
                return;
            }

            console.log('Attempting to fetch purchases for user ID:', userId);
            const userDoc = await db.collection('users').doc(userId).get();
            console.log('User data found:', userDoc.exists, 'User ID:', userId);
            
            if (!userDoc.exists) {
                console.log('No user document found');
                await interaction.respond([{
                    name: 'No user found with this ID',
                    value: '-1'
                }]);
                return;
            }

            const userData = userDoc.data();
            console.log('User purchases:', userData.purchases?.length || 0);

            if (!userData.purchases || userData.purchases.length === 0) {
                console.log('No purchases found for user');
                await interaction.respond([{
                    name: 'No purchases found for this user',
                    value: '-1'
                }]);
                return;
            }

            // Create choices from the purchases
            const choices = userData.purchases.map((purchase, index) => {
                const date = new Date(purchase.timestamp).toLocaleString();
                const price = typeof purchase.price === 'number' ? purchase.price.toFixed(2) : purchase.price;
                const shortTitle = `${date} - ${purchase.item} ($${price})`;
                
                return {
                    name: shortTitle.length > 100 ? shortTitle.substring(0, 97) + '...' : shortTitle,
                    value: index.toString()
                };
            }).reverse(); // Show most recent first

            console.log('Generated choices:', choices.length);
            await interaction.respond(choices.slice(0, 25));
        } catch (error) {
            console.error('Error handling autocomplete:', error);
            await interaction.respond([{
                name: 'Error loading purchases',
                value: '-1'
            }]);
        }
    }
});

// Add this after the existing interactionCreate handler
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isAutocomplete()) return;

    try {
        if (interaction.commandName === 'multiremove') {
            const multipliersDoc = await db.collection('config').doc('multipliers').get();
            if (!multipliersDoc.exists) {
                await interaction.respond([]);
                return;
            }

            const data = multipliersDoc.data();
            const events = data.events || [];
            const now = Date.now();

            // Filter to active and future events, format them for autocomplete
            const choices = events
                .filter(event => event.end >= now)
                .map(event => {
                    const startDate = new Date(event.start);
                    const endDate = new Date(event.end);
                    return {
                        name: `${event.multiplier}x (${startDate.toLocaleString('en-US', { timeZone: 'America/New_York' })} - ${endDate.toLocaleString('en-US', { timeZone: 'America/New_York' })})`,
                        value: `${event.start}_${event.end}_${event.multiplier}`
                    };
                })
                .slice(0, 25);

            await interaction.respond(choices);
        } else if (interaction.commandName === 'p' && (interaction.options.getSubcommand() === 'remove' || interaction.options.getSubcommand() === 'edit')) {
            const shopDoc = await db.collection('config').doc('shop').get();
            if (!shopDoc.exists) {
                await interaction.respond([]);
                return;
            }

            const products = shopDoc.data().products || [];
            const currencyName = await getCurrencyName();
            const choices = products.map(product => ({
                name: `\`${product.role.name}\` (${product.price} ${currencyName})${product.temporary ? ` - ${product.hours}h` : ' - Permanent'}${product.cooldown ? ` | CD: ${product.cooldown}h` : ''}`,
                value: product.role.id
            })).slice(0, 25);

            await interaction.respond(choices);
        }
    } catch (error) {
        console.error('Error handling autocomplete:', error);
        await interaction.respond([]);
    }
});

// Add this after the existing autocomplete handler
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isAutocomplete()) return;

    if (interaction.commandName === 'removelotto') {
        await lottery.handleLottoAutocomplete(interaction);
    }
});

// Message monitoring
client.on('messageCreate', async (message) => {
    if (message.channelId !== process.env.CHANNEL_ID) return;
    if (!db) {
        console.log('Skipping message processing: Database not initialized');
        return;
    }

    try {
        const content = message.content;
        console.log('Processing message:', content);
        console.log('Message content as array:', [...content].map(c => ({ char: c, code: c.charCodeAt(0) })));
        const match = content.match(/(\d+)\s+(.*?)\s+\[(.*?)\]\s+(?:USD|USD\s+|\$)(\d+\.?\d*)\s+((?:pi_[A-Za-z0-9]+|[A-Z0-9]+))/);
        console.log('Regex match result:', match);
        
        if (match) {
            const [_, userId, item, type, priceStr, transactionId] = match;
            console.log('Parsed values:', { userId, item, type, priceStr, transactionId });
            const price = parseFloat(priceStr);
            const basePoints = Math.floor(price);
            const multiplier = await getActiveMultiplier({ points: basePoints, userId });
            const points = Math.floor(basePoints * multiplier);
            const currentTime = Date.now();

            // Get user's document
            const userRef = db.collection('users').doc(userId);
            const userDoc = await userRef.get();
            const userData = userDoc.exists ? userDoc.data() : { points: 0, purchases: [] };

            // Get the user's information with force fetch and proper error handling
            let username = 'Unknown User';
            let discordUser = null;
            try {
                discordUser = await client.users.fetch(userId, { force: true });
                username = formatUsername(discordUser);
            } catch (error) {
                console.error('Error fetching username:', error);
                // If we can't fetch the user, try to use the stored username from their document
                username = userData.username || `User_${userId}`;
            }

            // Check for existing transaction
            const existingPurchase = userData.purchases?.find(p => p.transactionId === transactionId);

            if (existingPurchase) {
                // If this transaction already exists, add the item to it
                const purchaseIndex = userData.purchases.indexOf(existingPurchase);
                existingPurchase.items = existingPurchase.items || [existingPurchase.item];
                existingPurchase.items.push(`${item} [${type}]`);
                existingPurchase.item = existingPurchase.items.join(', ');
                
                // Update the purchase in Firestore
                userData.purchases[purchaseIndex] = existingPurchase;
                await userRef.update({ purchases: userData.purchases });

                // Send confirmation for additional item
                const updateEmbed = new EmbedBuilder()
                    .setColor(0x59DEFF)
                    .setTitle('🔄 Purchase Updated')
                    .setDescription(`Added item to transaction for ${username} (<@${userId}>)`)
                    .addFields(
                        { name: 'Added Item', value: `${item} [${type}]`, inline: true },
                        { name: 'Transaction Price', value: `$${existingPurchase.price}`, inline: true },
                        { name: 'Transaction ID', value: transactionId, inline: false }
                    );

                await message.channel.send({ embeds: [updateEmbed] });
            } else {
                // Create the purchase record for new transaction
                const purchase = {
                    item: `${item} [${type}]`,
                    items: [`${item} [${type}]`],
                    price: price,
                    timestamp: currentTime,
                    messageAuthor: message.author.id,
                    isBot: message.author.bot,
                    transactionId: transactionId,
                    username: username,
                    pointsAwarded: points // Track points awarded for this transaction
                };

                // Update user data with points and purchase for new transaction
                if (userDoc.exists) {
                    await userRef.update({
                        points: admin.firestore.FieldValue.increment(points),
                        purchases: admin.firestore.FieldValue.arrayUnion(purchase),
                        username: username // Store current username
                    });
                } else {
                    await userRef.set({
                        points: points,
                        purchases: [purchase],
                        username: username
                    });
                }

                // Calculate new total points
                const newTotalPoints = (userData.points || 0) + points;

                // Get current tier and update tier history if it's a new highest tier
                const newStatus = await getStatus({ points: newTotalPoints, userId });
                const currentStatus = await getStatus({ points: userData.points || 0, userId });

                const tierOrder = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
                if (tierOrder.indexOf(newStatus) > tierOrder.indexOf(currentStatus)) {
                    // User achieved a new tier, update history
                    await userRef.set({
                        tierHistory: {
                            [newStatus.toLowerCase()]: currentTime
                        }
                    }, { merge: true });

                    // Send tier up notification
                    const tierUpEmbed = new EmbedBuilder()
                        .setColor(getStatusColor(newStatus))
                        .setTitle('🎉 New Tier Achieved!')
                        .setDescription(`Congratulations ${username}! You've reached **${newStatus}** tier!`)
                        .addFields(
                            { name: 'Previous Tier', value: currentStatus, inline: true },
                            { name: 'New Tier', value: newStatus, inline: true }
                        );

                    // Add benefits field after getting them asynchronously
                    const benefits = await getTierBenefits(newStatus);
                    tierUpEmbed.addFields({ name: 'Benefits', value: benefits });

                    await message.channel.send({ embeds: [tierUpEmbed] });
                }

                // Update roles
                const member = await message.guild.members.fetch(userId);
                if (member) {
                    await updateUserRoles(member, newTotalPoints);
                }

                // Send confirmation for new purchase
                const confirmEmbed = new EmbedBuilder()
                    .setColor(0x59DEFF)
                    .setTitle('✅ Purchase Recorded')
                    .setDescription(`Successfully recorded purchase for ${username} (<@${userId}>)`)
                    .addFields(
                        { name: 'Item', value: `${item} [${type}]`, inline: true },
                        { name: 'Price', value: `$${price}`, inline: true },
                        { name: 'Points Earned', value: multiplier > 1 ? `+${points} (${multiplier}x)` : `+${points}`, inline: true },
                        { name: 'Transaction ID', value: transactionId, inline: false }
                    );

                await message.channel.send({ embeds: [confirmEmbed] });
                console.log(`Updated points for ${username} (${userId}): +${points} points for $${price} (Transaction: ${transactionId})`);

                // Force update leaderboard immediately
                try {
                    await updateLeaderboard();
                    console.log('Leaderboard updated after purchase');
                } catch (error) {
                    console.error('Error updating leaderboard:', error);
                }
            }
        }
    } catch (error) {
        console.error('Error processing message:', error);
        try {
            await message.channel.send({
                content: 'Failed to process purchase message. Please check the format and try again.',
                ephemeral: true
            });
        } catch (e) {
            console.error('Failed to send error message:', e);
        }
    }
});

// Command Handlers
async function handleRewardsCommand(interaction) {
    try {
        // Defer reply immediately
        await interaction.deferReply();
        
        const userId = interaction.user.id;
        const userDoc = await db.collection('users').doc(userId).get();
        const currencyName = await getCurrencyName();
        
        // Calculate total spent from purchases regardless of points
        let totalSpent = 0;
        if (userDoc.exists) {
            const userData = userDoc.data();
            const purchases = userData.purchases || [];
            totalSpent = purchases.reduce((sum, purchase) => sum + purchase.price, 0);
        }

        // Get points, ensure it's not negative for display
        const rawPoints = userDoc.exists ? userDoc.data().points || 0 : 0;
        const displayPoints = Math.max(0, rawPoints);

        // Get user's status based on display points
        const status = await getStatus({ points: displayPoints, userId });
        const nextStatus = getNextStatus(status);
        const pointsForNext = await getPointsForStatus(nextStatus);
        const pointsNeeded = Math.max(0, pointsForNext - displayPoints);
        const progressPercent = status === 'Diamond' ? 100 : Math.min(100, (displayPoints / pointsForNext) * 100);

        // Update roles
        await updateUserRoles(interaction.member, { points: displayPoints, userId });

        // Get status image if set
        const configDoc = await db.collection('config').doc('images').get();
        const statusImage = configDoc.exists ? configDoc.data()[status.toLowerCase()] : null;

        const progressBar = generateProgressBar(progressPercent);
        const statusEmoji = getStatusEmoji(status);

        const embed = new EmbedBuilder()
            .setColor(getStatusColor(status))
            .setTitle(`${statusEmoji} Your Rewards Status`)
            .setDescription(`Thank you for being a valued member of our community!`)
            .setThumbnail(interaction.user.displayAvatarURL());

        // Ensure all values are strings
        const pointsDisplay = rawPoints < 0 ? `${rawPoints} (0)` : displayPoints.toString();
        const spentDisplay = `$${totalSpent.toFixed(2)}`;
        const progressDisplay = status === 'Diamond' ? 
            'Congratulations on reaching Diamond status!' : 
            `${progressBar}\n${displayPoints}/${pointsForNext} ${currencyName} (${pointsNeeded} more for ${nextStatus})`;

        // Get tier benefits (now async)
        const tierBenefits = await getTierBenefits(status);

        // Add fields with guaranteed string values
        embed.addFields([
            { name: `Current ${currencyName.charAt(0).toUpperCase() + currencyName.slice(1)}`, value: pointsDisplay, inline: true },
            { name: 'Total Spent', value: spentDisplay, inline: true },
            { name: 'Current Status', value: status.toString(), inline: true },
            { name: 'Progress', value: progressDisplay },
            { name: '🌟 Tier Benefits', value: tierBenefits }
        ]);

        // Set the tier image if available
        if (statusImage) {
            embed.setImage(statusImage);
        }

        await interaction.editReply({ embeds: [embed], ephemeral: false });
        console.log(`Displayed rewards for ${interaction.user.username} - Points: ${displayPoints}, Status: ${status}`);
    } catch (error) {
        console.error('Error displaying rewards:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: 'An error occurred while displaying your rewards status.',
                ephemeral: true
            });
        } else {
            await interaction.editReply({ 
                content: 'An error occurred while displaying your rewards status.',
                ephemeral: true
            });
        }
    }
}

async function handleSetRoleCommand(interaction) {
    const tier = interaction.options.getString('tier');
    const role = interaction.options.getRole('role');

    await db.collection('config').doc('roles').set({
        [tier]: role.id
    }, { merge: true });

    await interaction.reply({ 
        content: `Successfully set ${role} as the reward for ${tier} tier!`,
        ephemeral: false 
    });

    // Update all users' roles
    const users = await db.collection('users').get();
    for (const user of users.docs) {
        try {
            const member = await interaction.guild.members.fetch(user.id);
            if (member) {
                await updateUserRoles(member, user.data().points || 0);
            }
        } catch (error) {
            console.error(`Error updating roles for user ${user.id}:`, error);
        }
    }
}

async function handleTopCommand(interaction) {
    const period = interaction.options.getString('period');
    const leaderboard = await generateLeaderboard(period);
    await interaction.reply({ embeds: [leaderboard] });
}

async function handleSetLeaderboardCommand(interaction) {
    leaderboardChannel = interaction.channel;
    
    // Store channel ID in Firestore
    await db.collection('config').doc('leaderboard').set({
        channelId: leaderboardChannel.id
    });

    // Create initial leaderboard
    const embed = await generateLeaderboard('alltime');
    leaderboardMessage = await interaction.channel.send({ embeds: [embed] });
    
    // Update Firestore with message ID
    await db.collection('config').doc('leaderboard').update({
        messageId: leaderboardMessage.id
    });

    await interaction.reply({ 
        content: 'Dynamic leaderboard has been set up in this channel!',
        ephemeral: true 
    });
}

async function handleSetImageCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const tier = interaction.options.getString('tier').toLowerCase();
        const imageUrl = interaction.options.getString('imageurl');

        // Store the image URL in Firestore
        await db.collection('config').doc('images').set({
            [tier]: imageUrl
        }, { merge: true });

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('✅ Tier Image Set')
            .setDescription(`Successfully set image for ${tier} tier.`)
            .setImage(imageUrl);

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error setting tier image:', error);
        await interaction.reply({
            content: 'An error occurred while setting the tier image.',
            ephemeral: false
        });
    }
}

async function handleGivePointsCommand(interaction) {
    // Check if user has admin permissions or the moderator role
    if (!interaction.member.permissions.has('Administrator') && !interaction.member.roles.cache.has('1181436356724002826')) {
        await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        return;
    }

    try {
        const targetType = interaction.options.getString('target_type');
        const points = interaction.options.getInteger('points');
        const reason = interaction.options.getString('reason') || 'No reason provided';
    const currencyName = await getCurrencyName();

        if (targetType === 'user') {
            const user = interaction.options.getUser('user');
            if (!user) {
                await interaction.reply({ content: 'Please specify a user when target type is user.', ephemeral: true });
                return;
            }

            // Give points to single user
            const userRef = db.collection('users').doc(user.id);
            await userRef.set({
                points: admin.firestore.FieldValue.increment(points)
            }, { merge: true });

            // Update user roles
            const member = await interaction.guild.members.fetch(user.id);
            await updateUserRoles(member, { points: (await userRef.get()).data()?.points || 0, userId: user.id });

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle(`💰 Points Given`)
                .setDescription(`Successfully gave points to ${user}`)
                .addFields(
                    { name: 'Amount', value: `${points} ${currencyName}`, inline: true },
                    { name: 'Reason', value: reason, inline: true }
                );

            await interaction.reply({ embeds: [embed], ephemeral: false });
        } else {
            const role = interaction.options.getRole('role');
            if (!role) {
                await interaction.reply({ content: 'Please specify a role when target type is role.', ephemeral: true });
                return;
            }

            // Get all members with the role
            const members = role.members;
            if (members.size === 0) {
                await interaction.reply({ content: 'No users found with this role.', ephemeral: true });
                return;
            }

            // Give points to all users with the role
            const batch = db.batch();
            members.forEach(member => {
                const userRef = db.collection('users').doc(member.id);
                batch.set(userRef, {
                    points: admin.firestore.FieldValue.increment(points)
                }, { merge: true });
            });

            await batch.commit();

            // Update roles for all affected users
            for (const [userId, member] of members) {
                const userRef = db.collection('users').doc(userId);
                const userData = await userRef.get();
                await updateUserRoles(member, { points: userData.data()?.points || 0, userId });
            }

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle(`💰 Points Given`)
                .setDescription(`Successfully gave points to all members with role ${role}`)
                .addFields(
                    { name: 'Amount per User', value: `${points} ${currencyName}`, inline: true },
                    { name: 'Total Users', value: members.size.toString(), inline: true },
                    { name: 'Total Points', value: `${points * members.size} ${currencyName}`, inline: true },
                    { name: 'Reason', value: reason, inline: true }
                );

            await interaction.reply({ embeds: [embed], ephemeral: false });
        }

        debouncedUpdateLeaderboard();
    } catch (error) {
        console.error('Error giving points:', error);
        await interaction.reply({
            content: 'An error occurred while giving points.',
            ephemeral: true
        });
    }
}

async function handleTakePointsCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: true });
        return;
    }

    try {
        const targetType = interaction.options.getString('target_type');
        const points = interaction.options.getInteger('points');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const currencyName = await getCurrencyName();

        if (targetType === 'user') {
            const user = interaction.options.getUser('user');
            if (!user) {
                await interaction.reply({ content: 'Please specify a user when target type is user.', ephemeral: true });
                return;
            }

            // Take points from single user
            const userRef = db.collection('users').doc(user.id);
            const userDoc = await userRef.get();
            const currentPoints = userDoc.exists ? userDoc.data().points || 0 : 0;

            if (currentPoints < points) {
                await interaction.reply({ 
                    content: `User only has ${currentPoints} ${currencyName}. Cannot take ${points} ${currencyName}.`,
                    ephemeral: true 
                });
                return;
            }

            await userRef.set({
                points: admin.firestore.FieldValue.increment(-points)
            }, { merge: true });

            // Update user roles
            const member = await interaction.guild.members.fetch(user.id);
            await updateUserRoles(member, { points: currentPoints - points, userId: user.id });

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle(`💰 Points Taken`)
                .setDescription(`Successfully took points from ${user}`)
                .addFields(
                    { name: 'Amount', value: `${points} ${currencyName}`, inline: true },
                    { name: 'Reason', value: reason, inline: true }
                );

            await interaction.reply({ embeds: [embed], ephemeral: false });
        } else {
            const role = interaction.options.getRole('role');
            if (!role) {
                await interaction.reply({ content: 'Please specify a role when target type is role.', ephemeral: true });
                return;
            }

            // Get all members with the role
            const members = role.members;
            if (members.size === 0) {
                await interaction.reply({ content: 'No users found with this role.', ephemeral: true });
                return;
            }

            // Check if all users have enough points
            const batch = db.batch();
            const updates = [];

            for (const [userId, member] of members) {
                const userRef = db.collection('users').doc(userId);
                const userDoc = await userRef.get();
                const currentPoints = userDoc.exists ? userDoc.data().points || 0 : 0;

                if (currentPoints >= points) {
                    updates.push({
                        ref: userRef,
                        points: currentPoints - points,
                        member: member
                    });
                }
            }

            if (updates.length === 0) {
                await interaction.reply({ 
                    content: `No users with this role have enough ${currencyName} to take.`,
                    ephemeral: true 
                });
                return;
            }

            // Take points from qualifying users
            updates.forEach(update => {
                batch.set(update.ref, {
                    points: admin.firestore.FieldValue.increment(-points)
                }, { merge: true });
            });

            await batch.commit();

            // Update roles for all affected users
            for (const update of updates) {
                await updateUserRoles(update.member, { points: update.points, userId: update.member.id });
            }

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle(`💰 Points Taken`)
                .setDescription(`Successfully took points from qualifying members with role ${role}`)
                .addFields(
                    { name: 'Amount per User', value: `${points} ${currencyName}`, inline: true },
                    { name: 'Affected Users', value: updates.length.toString(), inline: true },
                    { name: 'Total Points', value: `${points * updates.length} ${currencyName}`, inline: true },
                    { name: 'Skipped Users', value: (members.size - updates.length).toString(), inline: true },
                    { name: 'Reason', value: reason, inline: true }
                );

            await interaction.reply({ embeds: [embed], ephemeral: false });
        }

        debouncedUpdateLeaderboard();
    } catch (error) {
        console.error('Error taking points:', error);
        await interaction.reply({
            content: 'An error occurred while taking points.',
            ephemeral: true
        });
    }
}

async function handleResetPurchaseCommand(interaction) {
    try {
        // Defer the reply immediately to prevent timeout
        await interaction.deferReply({ ephemeral: false });

        const userId = interaction.options.getString('userid');
        const purchaseIndex = parseInt(interaction.options.getString('purchase'));

        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists || !userDoc.data().purchases || userDoc.data().purchases.length === 0) {
            await interaction.editReply({
                content: 'User has no purchases to reset.',
                ephemeral: false
            });
            return;
    }

    const userData = userDoc.data();
        const purchases = userData.purchases;
        
        if (purchaseIndex < 0 || purchaseIndex >= purchases.length) {
            await interaction.editReply({
                content: 'Invalid purchase selection.',
                ephemeral: false
            });
            return;
        }

        const selectedPurchase = purchases[purchaseIndex];
        const pointsToRemove = Math.floor(selectedPurchase.price);

        // Remove the selected purchase
        purchases.splice(purchaseIndex, 1);
        
        // Update user data and clear tier history
        await userRef.update({
            purchases: purchases,
            points: admin.firestore.FieldValue.increment(-pointsToRemove),
            tierHistory: {} // Clear tier history when resetting a purchase
        });

        // Add an admin action record
        const adminAction = {
            type: 'reset_purchase',
            purchase: selectedPurchase,
            timestamp: Date.now(),
            adminId: interaction.user.id
        };

        await userRef.update({
            adminActions: admin.firestore.FieldValue.arrayUnion(adminAction)
        });

        // Try to fetch Discord username for display
        let username = userId;
        try {
            const user = await client.users.fetch(userId);
            username = user.username;
        } catch (e) {
            console.log('Could not fetch username for ID:', userId);
        }

        // Update roles if member is in the server
        try {
            const member = await interaction.guild.members.fetch(userId);
            if (member) {
                const newTotal = userData.points - pointsToRemove;
                
                // Get current tier thresholds from Firestore
                const configDoc = await db.collection('config').doc('tiers').get();
                const tiers = configDoc.exists ? configDoc.data() : {
                    silver: 25,
                    gold: 250,
                    platinum: 500,
                    diamond: 1000
                };

                // Force update roles based on current points, ignoring tier retention
                const basicStatus = calculateBasicStatus(newTotal, tiers);
                await updateUserRoles(member, { points: newTotal, userId, forceStatus: basicStatus });
            }
        } catch (e) {
            console.log('User not in server, skipping role update');
        }

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('✅ Purchase Reset')
            .setDescription(`Successfully removed purchase from ${username}`)
            .addFields(
                { name: 'Removed Purchase', value: selectedPurchase.item, inline: true },
                { name: 'Points Removed', value: `${pointsToRemove}`, inline: true },
                { name: 'Original Price', value: `$${selectedPurchase.price}`, inline: true },
                { name: 'Purchase Date', value: new Date(selectedPurchase.timestamp).toLocaleString(), inline: false },
                { name: 'User ID', value: userId, inline: false }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        await updateLeaderboard();
    } catch (error) {
        console.error('Error resetting purchase:', error);
        try {
            await interaction.editReply({ 
                content: 'An error occurred while resetting the purchase.',
                ephemeral: false 
            });
        } catch (e) {
            console.error('Failed to send error message:', e);
        }
    }
}

async function handleCheckPurchasesCommand(interaction) {
    const userId = interaction.options.getString('userid');

    try {
        const userDoc = await db.collection('users').doc(userId).get();
        
        if (!userDoc.exists || !userDoc.data().purchases || userDoc.data().purchases.length === 0) {
            // Try to fetch username from Discord first
            let username = userId;
            try {
                const user = await client.users.fetch(userId);
                username = user.username;
            } catch (e) {
                console.log('Could not fetch Discord username');
            }
            
            await interaction.reply({
                content: `No purchase data found for ${username}`,
                ephemeral: false
            });
            return;
        }

        const userData = userDoc.data();
        const purchases = userData.purchases;
        
        // Get the username from the most recent purchase, or try Discord API
        let username = purchases[0]?.username || userId;
        if (!username || username === userId) {
            try {
                const user = await client.users.fetch(userId);
                username = user.username;
            } catch (e) {
                console.log('Could not fetch Discord username');
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle(`Purchase History for ${username}`)
            .setDescription(`Total Purchases: ${purchases.length}`);

        // Group purchases by month
        const purchasesByMonth = {};
        purchases.forEach(purchase => {
            const date = new Date(purchase.timestamp);
            const monthYear = date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
            
            if (!purchasesByMonth[monthYear]) {
                purchasesByMonth[monthYear] = [];
            }
            purchasesByMonth[monthYear].push(purchase);
        });

        // Add fields for each month's purchases
        Object.entries(purchasesByMonth).forEach(([monthYear, monthPurchases]) => {
            const monthlyTotal = monthPurchases.reduce((sum, p) => sum + p.price, 0);
            const purchaseList = monthPurchases
                .sort((a, b) => b.timestamp - a.timestamp)
                .map(p => {
                    const date = new Date(p.timestamp).toLocaleString('en-US', { 
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    return `${date} - ${p.item} ($${p.price})`;
                })
                .join('\n');

            embed.addFields({
                name: `${monthYear} (Total: $${monthlyTotal.toFixed(2)})`,
                value: purchaseList || 'No purchases',
                inline: false
            });
        });

        // Add total spent field
        const totalSpent = purchases.reduce((sum, p) => sum + p.price, 0);
        embed.addFields({
            name: 'Total Spent',
            value: `$${totalSpent.toFixed(2)}`,
            inline: true
        });

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error checking purchases:', error);
        await interaction.reply({
            content: 'An error occurred while checking purchases.',
            ephemeral: false
        });
    }
}

async function handleSalesCommand(interaction) {
    // Owner-only check
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    const period = interaction.options.getString('period');
    const now = Date.now();
    let cutoff;
    let periodName;

    switch (period) {
        case 'today':
            cutoff = new Date().setHours(0, 0, 0, 0);
            periodName = 'Today';
            break;
        case 'week':
            cutoff = now - 7 * 24 * 60 * 60 * 1000;
            periodName = 'This Week';
            break;
        case 'month':
            cutoff = now - 30 * 24 * 60 * 60 * 1000;
            periodName = 'This Month';
            break;
        default:
            cutoff = 0;
            periodName = 'All Time';
    }

    try {
        const users = await db.collection('users').get();
        let totalSales = 0;
        let totalRevenue = 0;
        let uniqueCustomers = new Set();
        let itemTypes = { monthly: 0, weekly: 0, lifetime: 0, single: 0 };
        let salesByDay = new Map();

        // Collect all purchases in the period
        users.forEach(doc => {
            const userData = doc.data();
            if (userData.purchases) {
                userData.purchases.forEach(purchase => {
                    if (purchase.timestamp > cutoff) {
                        // For today's data, use hourly format
                        const date = period === 'today' 
                            ? new Date(purchase.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                            : new Date(purchase.timestamp).toLocaleDateString();
                        salesByDay.set(date, (salesByDay.get(date) || 0) + 1);
                        uniqueCustomers.add(doc.id);
                        totalRevenue += purchase.price;
                        totalSales++;

                        if (purchase.item.toLowerCase().includes('monthly')) itemTypes.monthly++;
                        else if (purchase.item.toLowerCase().includes('weekly')) itemTypes.weekly++;
                        else if (purchase.item.toLowerCase().includes('lifetime')) itemTypes.lifetime++;
                        else if (purchase.item.toLowerCase().includes('single')) itemTypes.single++;
                    }
                });
            }
        });

        // If viewing today's data, fill in missing hours with 0s
        if (period === 'today') {
            const hours = new Map();
            const now = new Date();
            const startOfDay = new Date().setHours(0, 0, 0, 0);
            
            // Create entries for each hour from start of day to now
            for (let h = new Date(startOfDay); h <= now; h = new Date(h.setHours(h.getHours() + 1))) {
                const hourStr = h.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                // Only add hours up to the current hour
                if (new Date(h).getTime() <= now.getTime()) {
                    hours.set(hourStr, 0); // Initialize with 0
                }
            }

            // Add the actual sales data
            for (const [time, count] of salesByDay.entries()) {
                hours.set(time, count);
            }
            
            salesByDay = hours;
        }

        // Prepare chart data
        const sortedDays = Array.from(salesByDay.entries())
            .sort((a, b) => {
                if (period === 'today') {
                    return new Date('1970/01/01 ' + a[0]) - new Date('1970/01/01 ' + b[0]);
                }
                return new Date(a[0]) - new Date(b[0]);
            });

        // Create sales trend chart with improved formatting
        const salesTrendConfig = {
            type: 'line',
            data: {
                labels: sortedDays.map(([date]) => date),
                datasets: [{
                    label: 'Sales',
                    data: sortedDays.map(([_, count]) => count),
                    borderColor: '#59DEFF',
                    backgroundColor: 'rgba(89, 222, 255, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }]
            },
            options: {
                title: {
                    display: true,
                    text: period === 'today' ? 'Hourly Sales Today' : 'Sales Trend',
                    fontSize: 16
                },
                scales: {
                    yAxes: [{
                        ticks: {
                            beginAtZero: true,
                            precision: 0,
                            stepSize: 1
                        },
                        gridLines: {
                            drawBorder: true,
                            color: 'rgba(200, 200, 200, 0.2)'
                        }
                    }],
                    xAxes: [{
                        gridLines: {
                            drawBorder: true,
                            color: 'rgba(200, 200, 200, 0.2)'
                        }
                    }]
                },
                legend: {
                    display: true,
                    position: 'top'
                }
            }
        };

        // Create item types pie chart
        const itemTypesConfig = {
            type: 'pie',
            data: {
                labels: ['Monthly', 'Weekly', 'Lifetime', 'Single'],
                datasets: [{
                    data: [itemTypes.monthly, itemTypes.weekly, itemTypes.lifetime, itemTypes.single],
                    backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0']
                }]
            },
            options: {
                title: {
                    display: true,
                    text: 'Sales by Type'
                }
            }
        };

        const avgOrderValue = totalRevenue / totalSales || 0;
        const dailyRevenue = totalRevenue / (period === 'today' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 365);

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle(`📊 Sales Analytics - ${periodName}`)
            .addFields(
                { name: '💰 Total Revenue', value: `$${totalRevenue.toFixed(2)}`, inline: true },
                { name: '🛍️ Total Sales', value: totalSales.toString(), inline: true },
                { name: '👥 Unique Customers', value: uniqueCustomers.size.toString(), inline: true },
                { name: '📈 Average Order Value', value: `$${avgOrderValue.toFixed(2)}`, inline: true },
                { name: '📅 Daily Average Revenue', value: `$${dailyRevenue.toFixed(2)}`, inline: true },
                { name: '\u200B', value: '\u200B', inline: true }
            )
            .setImage(generateChartUrl(salesTrendConfig))
            .setTimestamp();

        const typeEmbed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('Sales Distribution by Type')
            .setImage(generateChartUrl(itemTypesConfig));

        await interaction.reply({ embeds: [embed, typeEmbed], ephemeral: true });
    } catch (error) {
        console.error('Error generating sales report:', error);
        await interaction.reply({ content: 'An error occurred while generating the sales report.', ephemeral: false });
    }
}

async function handleBestsellersCommand(interaction) {
    // Owner-only check
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    const period = interaction.options.getString('period');
    const now = Date.now();
    const cutoff = period === 'week' ? now - 7 * 24 * 60 * 60 * 1000 :
                  period === 'month' ? now - 30 * 24 * 60 * 60 * 1000 : 0;

    try {
        const users = await db.collection('users').get();
        const itemStats = new Map(); // Map to store item statistics

        // Collect all purchases
        users.forEach(doc => {
            const userData = doc.data();
            if (userData.purchases) {
                userData.purchases.forEach(purchase => {
                    if (purchase.timestamp > cutoff) {
                        const stats = itemStats.get(purchase.item) || { count: 0, revenue: 0 };
                        stats.count++;
                        stats.revenue += purchase.price;
                        itemStats.set(purchase.item, stats);
                    }
                });
            }
        });

        // Convert to array and sort by count
        const sortedItems = Array.from(itemStats.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle(`🏆 Top Selling Items - ${period.charAt(0).toUpperCase() + period.slice(1)}`)
            .setDescription('Top 10 best-selling items by number of sales')
            .addFields(
                sortedItems.map((item, index) => ({
                    name: `${index + 1}. ${item[0]}`,
                    value: `Sales: ${item[1].count}\nRevenue: $${item[1].revenue.toFixed(2)}`,
                    inline: false
                }))
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        console.error('Error generating bestsellers report:', error);
        await interaction.reply({ content: 'An error occurred while generating the bestsellers report.', ephemeral: false });
    }
}

async function handleRevenueCommand(interaction) {
    // Owner-only check
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: true });
        return;
    }

    const period = interaction.options.getString('period');
    const type = interaction.options.getString('type') || 'all';
    const now = Date.now();
    let cutoff;
    let periodName;

    switch (period) {
        case 'today':
            cutoff = new Date().setHours(0, 0, 0, 0);
            periodName = 'Today';
            break;
        case 'week':
            cutoff = now - 7 * 24 * 60 * 60 * 1000;
            periodName = 'This Week';
            break;
        case 'month':
            cutoff = now - 30 * 24 * 60 * 60 * 1000;
            periodName = 'This Month';
            break;
        case 'year':
            cutoff = now - 365 * 24 * 60 * 60 * 1000;
            periodName = 'This Year';
            break;
    }

    try {
        const users = await db.collection('users').get();
        let totalRevenue = 0;
        let revenueByDay = new Map();
        let revenueByType = {
            monthly: 0,
            weekly: 0,
            lifetime: 0,
            single: 0
        };

        users.forEach(doc => {
            const userData = doc.data();
            if (userData.purchases) {
                userData.purchases.forEach(purchase => {
                    if (purchase.timestamp > cutoff) {
                        if (type !== 'all' && !purchase.item.toLowerCase().includes(type)) return;

                        const date = new Date(purchase.timestamp).toLocaleDateString();
                        revenueByDay.set(date, (revenueByDay.get(date) || 0) + purchase.price);
                        totalRevenue += purchase.price;

                        if (purchase.item.toLowerCase().includes('monthly')) revenueByType.monthly += purchase.price;
                        else if (purchase.item.toLowerCase().includes('weekly')) revenueByType.weekly += purchase.price;
                        else if (purchase.item.toLowerCase().includes('lifetime')) revenueByType.lifetime += purchase.price;
                        else if (purchase.item.toLowerCase().includes('single')) revenueByType.single += purchase.price;
                    }
                });
            }
        });

        // Prepare chart data
        const sortedDays = Array.from(revenueByDay.entries())
            .sort((a, b) => new Date(a[0]) - new Date(b[0]));

        // Create revenue trend chart
        const revenueTrendConfig = {
            type: 'line',
            data: {
                labels: sortedDays.map(([date]) => date),
                datasets: [{
                    label: 'Revenue ($)',
                    data: sortedDays.map(([_, amount]) => amount.toFixed(2)),
                    borderColor: '#59DEFF',
                    fill: false
                }]
            },
            options: {
                title: {
                    display: true,
                    text: 'Revenue Trend'
                }
            }
        };

        // Create revenue by type chart
        const revenueTypeConfig = {
            type: 'doughnut',
            data: {
                labels: ['Monthly', 'Weekly', 'Lifetime', 'Single'],
                datasets: [{
                    data: [
                        revenueByType.monthly.toFixed(2),
                        revenueByType.weekly.toFixed(2),
                        revenueByType.lifetime.toFixed(2),
                        revenueByType.single.toFixed(2)
                    ],
                    backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0']
                }]
            },
            options: {
                title: {
                    display: true,
                    text: 'Revenue Distribution'
                }
            }
        };

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle(`💰 Revenue Analysis - ${periodName}${type !== 'all' ? ` (${type})` : ''}`)
            .addFields(
                { name: '💵 Total Revenue', value: `$${totalRevenue.toFixed(2)}`, inline: false },
                { name: '📊 Revenue by Type', value: 
                    `Monthly: $${revenueByType.monthly.toFixed(2)}\n` +
                    `Weekly: $${revenueByType.weekly.toFixed(2)}\n` +
                    `Lifetime: $${revenueByType.lifetime.toFixed(2)}\n` +
                    `Single: $${revenueByType.single.toFixed(2)}`,
                    inline: false
                }
            )
            .setImage(generateChartUrl(revenueTrendConfig))
            .setTimestamp();

        const typeEmbed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('Revenue Distribution by Type')
            .setImage(generateChartUrl(revenueTypeConfig));

        await interaction.reply({ embeds: [embed, typeEmbed], ephemeral: true });
    } catch (error) {
        console.error('Error generating revenue report:', error);
        await interaction.reply({ content: 'An error occurred while generating the revenue report.', ephemeral: true });
    }
}

async function handleMultiplierCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: true });
        return;
    }

    try {
        const multiplier = interaction.options.getInteger('multiplier');
        const startStr = interaction.options.getString('start');
        const endStr = interaction.options.getString('end');
        const announcementChannel = interaction.options.getChannel('announcement');

        // Parse dates (assuming EST input)
        const start = new Date(startStr + ' EST');
        const end = new Date(endStr + ' EST');

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            await interaction.reply({
                content: 'Invalid date format. Please use format: YYYY-MM-DD HH:mm',
                ephemeral: true
            });
            return;
        }

        if (end <= start) {
            await interaction.reply({
                content: 'End time must be after start time.',
                ephemeral: true
            });
            return;
        }

        // Store multiplier event in Firestore
        const multiplierEvent = {
            multiplier: multiplier,
            start: start.getTime(),
            end: end.getTime(),
            createdBy: interaction.user.id,
            createdAt: Date.now()
        };

        await db.collection('config').doc('multipliers').set({
            events: admin.firestore.FieldValue.arrayUnion(multiplierEvent)
        }, { merge: true });

        // Create embed for response and announcement
        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🎉 Points Multiplier Event')
            .setDescription(`Points will be multiplied by ${multiplier}x!`)
            .addFields(
                { name: 'Start Time', value: start.toLocaleString('en-US', { timeZone: 'America/New_York' }), inline: true },
                { name: 'End Time', value: end.toLocaleString('en-US', { timeZone: 'America/New_York' }), inline: true },
                { name: 'Multiplier', value: `${multiplier}x points`, inline: true }
            );

        // Send confirmation to command user
        await interaction.reply({ embeds: [embed], ephemeral: false });

        // If announcement channel is specified, announce there
        if (announcementChannel) {
            await announcementChannel.send({ embeds: [embed] });
        }
    } catch (error) {
        console.error('Error setting multiplier:', error);
        await interaction.reply({
            content: 'An error occurred while setting the multiplier.',
            ephemeral: false
        });
    }
}

async function getActiveMultiplier(pointsData) {
    try {
        const multipliersDoc = await db.collection('config').doc('multipliers').get();
        const tierMultipliersDoc = await db.collection('config').doc('tierMultipliers').get();
        
        // Get event multiplier
        let eventMultiplier = 1;
        if (multipliersDoc.exists) {
            const data = multipliersDoc.data();
            const events = data.events || [];
            const now = Date.now();

            // Find active multiplier
            const activeEvent = events.find(event => 
                event.start <= now && event.end >= now
            );

            if (activeEvent) {
                eventMultiplier = activeEvent.multiplier;
            }
        }

        // Get tier multiplier
        let tierMultiplier = 1;
        if (tierMultipliersDoc.exists && pointsData) {
            const data = tierMultipliersDoc.data();
            const status = await getStatus(pointsData);
            const tierMult = data[status.toLowerCase()];
            if (tierMult) {
                tierMultiplier = tierMult;
            }
        }

        // Return combined multiplier (event multiplier * tier multiplier)
        return eventMultiplier * tierMultiplier;
    } catch (error) {
        console.error('Error checking multiplier:', error);
        return 1;
    }
}

// Helper Functions
async function updateLeaderboard() {
    if (!leaderboardChannel || !db) {
        console.log('Skipping leaderboard update: Channel or DB not initialized');
        return;
    }

    try {
        console.log('Generating new leaderboard...');
        const embed = await generateLeaderboard('alltime');
        
        if (!leaderboardMessage) {
            // Try to fetch the message ID from Firestore
            const configDoc = await db.collection('config').doc('leaderboard').get();
            if (configDoc.exists && configDoc.data().messageId) {
                try {
                    leaderboardMessage = await leaderboardChannel.messages.fetch(configDoc.data().messageId);
                } catch (error) {
                    console.log('Previous leaderboard message not found, creating new one');
                }
            }
        }

        if (leaderboardMessage) {
            await leaderboardMessage.edit({ embeds: [embed] });
            console.log('Existing leaderboard message updated');
        } else {
            leaderboardMessage = await leaderboardChannel.send({ embeds: [embed] });
            await db.collection('config').doc('leaderboard').set({
                channelId: leaderboardChannel.id,
                messageId: leaderboardMessage.id
            });
            console.log('New leaderboard message created');
        }

        // Also update the spentboard if it exists
        if (spentboardChannel) {
            await updateSpentboard();
        }
    } catch (error) {
        console.error('Error updating leaderboard:', error);
        // Try to recreate the leaderboard message if it failed
        try {
            const embed = await generateLeaderboard('alltime');
            leaderboardMessage = await leaderboardChannel.send({ embeds: [embed] });
            await db.collection('config').doc('leaderboard').set({
                channelId: leaderboardChannel.id,
                messageId: leaderboardMessage.id
            });
            console.log('Leaderboard message recreated after error');
        } catch (retryError) {
            console.error('Failed to recreate leaderboard:', retryError);
        }
    }
}

async function generateLeaderboard(period) {
    const userData = await getCachedUserData();
    const currencyName = await getCurrencyName();
    let leaderboardData = [];

    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

    for (const [userId, data] of userData) {
        let points = 0;

        if (period === 'weekly' || period === 'monthly') {
            const cutoff = period === 'weekly' ? weekAgo : monthAgo;
            points = (data.purchases || [])
                .filter(p => p.timestamp > cutoff)
                .reduce((sum, p) => sum + Math.floor(p.price), 0);
        } else {
            points = data.points || 0;
        }

        if (points > 0) {
            leaderboardData.push({
                id: userId,
                points: points
            });
        }
    }

    leaderboardData.sort((a, b) => b.points - a.points);
    const top10 = leaderboardData.slice(0, 10);

    // Fetch user information for each entry
    const leaderboardFields = [];
    for (const [index, user] of top10.entries()) {
        try {
            const discordUser = await client.users.fetch(user.id);
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
            leaderboardFields.push({
                name: `${medal} ${index + 1}. ${discordUser.username}`,
                value: `${user.points} ${currencyName}`,
                inline: false
            });
        } catch (error) {
            console.error(`Error fetching user ${user.id}:`, error);
            leaderboardFields.push({
                name: `${index + 1}. Unknown User`,
                value: `${user.points} ${currencyName}`,
                inline: false
            });
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0x59DEFF)
        .setTitle(`🏆 __${currencyName}__ __Leaderboard__ 🏆`)
        .setDescription(period === 'alltime' ? '**Top Dogs:**' : 
                       period === 'weekly' ? '**This Week\'s Top Dogs**' : 
                       '**This Month\'s Mega Homies**')
        .addFields(leaderboardFields)
        .setTimestamp();

    return embed;
}

async function updateUserRoles(member, pointsData) {
    try {
        // Get roles from cache or fetch if needed
        const now = Date.now();
        let rolesConfig;
        if (CACHE.roles && (now - CACHE.rolesLastFetch) < CACHE_TTL) {
            rolesConfig = CACHE.roles;
        } else {
            const rolesDoc = await db.collection('config').doc('roles').get();
            CACHE.roles = rolesDoc.data() || {};
            CACHE.rolesLastFetch = now;
            rolesConfig = CACHE.roles;
        }

        // Use forced status if provided, otherwise calculate normally
        const status = pointsData.forceStatus || await getStatus(pointsData);
        
        console.log(`Updating roles for ${member.user.tag} (${member.id})`);
        console.log(`Current points: ${typeof pointsData === 'number' ? pointsData : pointsData.points}, Status: ${status}`);
        console.log('Roles config:', rolesConfig);

        // Get all tier roles up to and including current tier
        const tierOrder = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
        const currentTierIndex = tierOrder.indexOf(status.toLowerCase());
        const tiersToHave = tierOrder.slice(0, currentTierIndex + 1);
        const tiersToRemove = tierOrder.slice(currentTierIndex + 1);

        console.log('Tiers to have:', tiersToHave);
        console.log('Tiers to remove:', tiersToRemove);

        // Check if user has reached a new tier
        const userDoc = await db.collection('users').doc(member.id).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        const previousTier = userData.currentTier || 'none';
        const hasNewTier = status.toLowerCase() !== previousTier.toLowerCase();

        // Add roles for tiers they should have
        for (const tier of tiersToHave) {
            const roleId = rolesConfig[tier];
            console.log(`Checking ${tier} role (ID: ${roleId})`);
            if (roleId) {
                try {
                    if (!member.roles.cache.has(roleId)) {
                        await member.roles.add(roleId);
                        console.log(`Added ${tier} role to ${member.user.tag}`);
                    } else {
                        console.log(`Member already has ${tier} role`);
                    }
                } catch (error) {
                    console.error(`Error adding ${tier} role:`, error);
                }
            }
        }

        // Remove roles for tiers they shouldn't have
        for (const tier of tiersToRemove) {
            const roleId = rolesConfig[tier];
            if (roleId && member.roles.cache.has(roleId)) {
                try {
                    await member.roles.remove(roleId);
                    console.log(`Removed ${tier} role from ${member.user.tag}`);
                } catch (error) {
                    console.error(`Error removing ${tier} role:`, error);
                }
            }
        }

        // If they reached a new tier, send the DM
        if (hasNewTier) {
            try {
                // Get tier DM template
                const tierDMsDoc = await db.collection('config').doc('tierDMs').get();
                const tierDMs = tierDMsDoc.exists ? tierDMsDoc.data() : {};
                const dmTemplate = tierDMs[status.toLowerCase()];

                if (dmTemplate) {
                    // Get tier expiration date if set
                    const settingsDoc = await db.collection('config').doc('settings').get();
                    const settings = settingsDoc.exists ? settingsDoc.data() : {};
                    const retentionDays = settings.tierRetention?.[status.toLowerCase()] || 30;
                    const expireDate = Date.now() + (retentionDays * 24 * 60 * 60 * 1000);

                    // Prepare data for placeholders
                    const placeholderData = {
                        tier: status,
                        points: typeof pointsData === 'number' ? pointsData : pointsData.points,
                        expireDate,
                        currencyName: await getCurrencyName(),
                        nextTier: getNextTier(status),
                        nextTierPoints: await getPointsForStatus(getNextTier(status))
                    };

                    // Replace placeholders and send DM
                    const dmContent = replacePlaceholders(dmTemplate, placeholderData)
                        .replace(/{Username}/g, member.user.username)
                        .replace(/{UserMention}/g, `<@${member.id}>`);

                    await member.send(dmContent).catch(error => {
                        console.error('Error sending tier DM:', error);
                    });
                }

                // Update user's current tier
                await db.collection('users').doc(member.id).set({
                    currentTier: status.toLowerCase(),
                    tierHistory: {
                        [status.toLowerCase()]: Date.now()
                    }
                }, { merge: true });
            } catch (error) {
                console.error('Error handling tier DM:', error);
            }
        }

    } catch (error) {
        console.error('Error updating roles:', error);
    }
}

async function calculateStatus(points) {
    try {
        const configDoc = await db.collection('config').doc('tiers').get();
        const tiers = configDoc.exists ? configDoc.data() : {
            silver: 25,
            gold: 250,
            platinum: 500,
            diamond: 1000
        };

        points = Math.max(0, points); // Ensure points is not negative
        if (points >= tiers.diamond) return 'Diamond';
        if (points >= tiers.platinum) return 'Platinum';
        if (points >= tiers.gold) return 'Gold';
        if (points >= tiers.silver) return 'Silver';
        return 'Bronze';
    } catch (error) {
        console.error('Error getting tier points:', error);
        // Fallback to default values if there's an error
        points = Math.max(0, points);
        if (points >= 1000) return 'Diamond';
        if (points >= 500) return 'Platinum';
        if (points >= 250) return 'Gold';
        if (points >= 25) return 'Silver';
        return 'Bronze';
    }
}

function getStatusColor(status) {
    switch (status) {
        case 'Diamond': return 0x59DEFF;
        case 'Platinum': return 0xE5E4E2;
        case 'Gold': return 0xFFD700;
        case 'Silver': return 0xC0C0C0;
        default: return 0xCD7F32;
    }
}

function getNextTier(currentStatus) {
    switch (currentStatus) {
        case 'Bronze': return 'Silver';
        case 'Silver': return 'Gold';
        case 'Gold': return 'Platinum';
        case 'Platinum': return 'Diamond';
        default: return 'Diamond';
    }
}

function getProgressBar(points, nextTier) {
    const progress = Math.min(points / nextTier * 10, 10);
    const filledBars = '█'.repeat(Math.floor(progress));
    const emptyBars = '░'.repeat(10 - Math.floor(progress));
    return `${filledBars}${emptyBars} ${points}/${nextTier}`;
}

function getStatusEmoji(status) {
    switch (status) {
        case 'Diamond': return '💎';
        case 'Platinum': return '🌟';
        case 'Gold': return '🏆';
        case 'Silver': return '🥈';
        default: return '🥉';
    }
}

async function getTierBenefits(status) {
    try {
        const benefitsDoc = await db.collection('config').doc('benefits').get();
        if (benefitsDoc.exists) {
            const benefits = benefitsDoc.data()[status.toLowerCase()];
            if (benefits && benefits.length > 0) {
                return benefits.map(b => `• ${b}`).join('\n');
            }
        }

        // Fallback to default benefits if none are set
        switch (status) {
            case 'Diamond':
                return '• Exclusive Diamond Role\n• Priority Support\n• Special Discord Color\n• Maximum Rewards\n• Custom Benefits';
            case 'Platinum':
                return '• Exclusive Platinum Role\n• Enhanced Support\n• Special Discord Color\n• Increased Rewards';
            case 'Gold':
                return '• Exclusive Gold Role\n• Priority Support\n• Special Discord Color';
            case 'Silver':
                return '• Exclusive Silver Role\n• Special Discord Color';
            default:
                return '• Basic Member Benefits\n• Bronze Role';
        }
    } catch (error) {
        console.error('Error getting tier benefits:', error);
        return '• Error loading benefits';
    }
}

function generateChartUrl(config) {
    const encodedConfig = encodeURIComponent(JSON.stringify(config));
    return `${CHART_BASE_URL}?c=${encodedConfig}`;
}

async function handleMultiListCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: true });
        return;
    }

    try {
        const multipliersDoc = await db.collection('config').doc('multipliers').get();
        if (!multipliersDoc.exists) {
            await interaction.reply({ content: 'No multiplier events found.', ephemeral: true });
            return;
        }

        const data = multipliersDoc.data();
        const events = data.events || [];
        const now = Date.now();

        // Separate events into active and upcoming
        const activeEvents = events.filter(event => event.start <= now && event.end >= now);
        const upcomingEvents = events.filter(event => event.start > now);

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('📊 Multiplier Events')
            .setDescription('Current and upcoming point multiplier events');

        if (activeEvents.length > 0) {
            const activeField = activeEvents.map(event => {
                const start = new Date(event.start);
                const end = new Date(event.end);
                return `${event.multiplier}x Points\n📅 ${start.toLocaleString('en-US', { timeZone: 'America/New_York' })} - ${end.toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
            }).join('\n\n');
            embed.addFields({ name: '🟢 Active Events', value: activeField });
        }

        if (upcomingEvents.length > 0) {
            const upcomingField = upcomingEvents.map(event => {
                const start = new Date(event.start);
                const end = new Date(event.end);
                return `${event.multiplier}x Points\n📅 ${start.toLocaleString('en-US', { timeZone: 'America/New_York' })} - ${end.toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
            }).join('\n\n');
            embed.addFields({ name: '⏳ Upcoming Events', value: upcomingField });
        }

        if (activeEvents.length === 0 && upcomingEvents.length === 0) {
            embed.setDescription('No active or upcoming multiplier events.');
        }

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error listing multipliers:', error);
        await interaction.reply({
            content: 'An error occurred while listing multiplier events.',
            ephemeral: false
        });
    }
}

async function handleMultiRemoveCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const eventValue = interaction.options.getString('event');
        const [start, end, multiplier] = eventValue.split('_').map(Number);

        const multipliersDoc = await db.collection('config').doc('multipliers').get();
        if (!multipliersDoc.exists) {
            await interaction.reply({ content: 'No multiplier events found.', ephemeral: true });
            return;
        }

        const data = multipliersDoc.data();
        const events = data.events || [];

        // Find and remove the event
        const eventToRemove = events.find(event => 
            event.start === start && 
            event.end === end && 
            event.multiplier === multiplier
        );

        if (!eventToRemove) {
            await interaction.reply({ content: 'Event not found.', ephemeral: false });
            return;
        }

        // Remove the event
        await db.collection('config').doc('multipliers').update({
            events: events.filter(event => 
                event.start !== start || 
                event.end !== end || 
                event.multiplier !== multiplier
            )
        });

        const startDate = new Date(start);
        const endDate = new Date(end);
        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🗑️ Multiplier Event Removed')
            .setDescription(`Successfully removed the following multiplier event:`)
            .addFields(
                { name: 'Multiplier', value: `${multiplier}x points`, inline: true },
                { name: 'Start Time', value: startDate.toLocaleString('en-US', { timeZone: 'America/New_York' }), inline: true },
                { name: 'End Time', value: endDate.toLocaleString('en-US', { timeZone: 'America/New_York' }), inline: true }
            );

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error removing multiplier:', error);
        await interaction.reply({
            content: 'An error occurred while removing the multiplier event.',
            ephemeral: false
        });
    }
}

// Update the formatDuration function to handle both minutes and hours
function formatDuration(hours) {
    if (!hours) return 'None';
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        return `${days} Day${days === 1 ? '' : 's'}`;
    }
    if (hours >= 1) {
        return `${hours} Hour${hours === 1 ? '' : 's'}`;
    }
    return `${Math.round(hours * 60)} Minute${Math.round(hours * 60) === 1 ? '' : 's'}`;
}

// Update the shop display to use the formatDuration function
async function handleShopCommand(interaction) {
    try {
        const shopDoc = await db.collection('config').doc('shop').get();
        if (!shopDoc.exists || !shopDoc.data().products || shopDoc.data().products.length === 0) {
            await interaction.reply({ content: 'The shop is currently empty.', ephemeral: false });
            return;
        }

        // Sort products by position
        const products = [...shopDoc.data().products].sort((a, b) => (a.position || 999) - (b.position || 999));
        const userDoc = await db.collection('users').doc(interaction.user.id).get();
        const userPoints = userDoc.exists ? userDoc.data().points || 0 : 0;
        const currencyName = await getCurrencyName();
        const userDiscount = await getUserDiscount(interaction.member);

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🛍️ Rewards Shop')
            .setDescription(`<@${interaction.user.id}>'s balance: **${userPoints} ${currencyName}**${userDiscount > 0 ? `\nYour tier discount: **${userDiscount}% off!**` : ''}\n\nClick a button below to purchase an item!`)
            .addFields(
                products.map(product => {
                    const originalPrice = product.price;
                    const discountedPrice = Math.floor(originalPrice * (1 - userDiscount / 100));
                    const priceDisplay = userDiscount > 0 ? 
                        `~~${originalPrice}~~ ${discountedPrice} ${currencyName}  (${userDiscount}% off!)` :
                        `${originalPrice} ${currencyName} `;

                    return {
                        name: `**__${product.role.name}__**:\n${priceDisplay}`,
                        value: `\`\`\`Removes in: ${product.temporary ? formatDuration(product.hours) : 'Never / Until used up (Rolls)'}\nCooldown: ${product.cooldown ? formatCooldown(product.cooldown, product.cooldownUnit) : 'None'}\nRequired Role: ${product.requiredRole ? product.requiredRole.name : 'None'}\`\`\``,
                        inline: true
                    };
                })
            );

        // Create rows of buttons (max 5 buttons per row)
        const rows = [];
        for (let i = 0; i < products.length; i += 5) {
            const row = new ActionRowBuilder()
                .addComponents(
                    products.slice(i, i + 5).map(product => {
                        const hasRequiredRole = !product.requiredRole || interaction.member.roles.cache.has(product.requiredRole.id);
                        const discountedPrice = Math.floor(product.price * (1 - userDiscount / 100));
                        return new ButtonBuilder()
                            .setCustomId(`buy_${product.role.id}`)
                            .setLabel(product.role.name)
                            .setStyle(ButtonStyle.Danger)
                            .setDisabled(userPoints < discountedPrice || !hasRequiredRole);
                    })
                );
            rows.push(row);
        }

        await interaction.reply({ embeds: [embed], components: rows, ephemeral: false });
    } catch (error) {
        console.error('Error displaying shop:', error);
        await interaction.reply({ content: 'An error occurred while displaying the shop.', ephemeral: false });
    }
}

async function handleProductCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    const subcommand = interaction.options.getSubcommand();

    try {
        if (subcommand === 'add') {
            const role = interaction.options.getRole('role');
            const price = interaction.options.getInteger('price');
            const remove = interaction.options.getBoolean('remove') || false;
            const time = interaction.options.getInteger('time');
            const timeUnit = interaction.options.getString('timeunit') || 'hours';
            const cooldown = interaction.options.getInteger('cooldown');
            const cooldownUnit = interaction.options.getString('cooldown_unit') || 'hours';
            const requiredRole = interaction.options.getRole('required_role');
            const position = interaction.options.getInteger('position') ?? 999;

            if (remove && !time) {
                await interaction.reply({ 
                    content: 'You must specify the time if the role should be removed.',
                    ephemeral: false 
                });
                return;
            }

            // Convert time to hours for storage
            const hours = timeUnit === 'minutes' ? time / 60 : 
                         timeUnit === 'days' ? time * 24 : time;

            // Convert cooldown to minutes for storage
            const cooldownMinutes = cooldown ? 
                (cooldownUnit === 'hours' ? cooldown * 60 : 
                 cooldownUnit === 'days' ? cooldown * 24 * 60 : 
                 cooldown) : null;

            const product = {
                role: {
                    id: role.id,
                    name: role.name
                },
                price: price,
                temporary: remove,
                hours: hours,
                cooldown: cooldownMinutes,
                cooldownUnit: cooldownUnit,
                position: position,
                requiredRole: requiredRole ? {
                    id: requiredRole.id,
                    name: requiredRole.name
                } : null
            };

            // Get current products
            const shopDoc = await db.collection('config').doc('shop').get();
            const products = shopDoc.exists ? shopDoc.data().products || [] : [];

            // If position is specified, handle insertion
            if (position !== 999) {
                // Shift positions of other products if needed
                products.forEach(p => {
                    if (p.position >= position) {
                        p.position = (p.position || 0) + 1;
                    }
                });
            }

            // Add new product
            products.push(product);

            // Sort products by position
            products.sort((a, b) => (a.position || 999) - (b.position || 999));

            // Update shop with sorted products
            await db.collection('config').doc('shop').set({ products });

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle('✅ Product Added')
                .addFields(
                    { name: 'Role', value: role.name, inline: true },
                    { name: 'Price', value: `${price} points`, inline: true },
                    { name: 'Duration', value: remove ? `${time} ${timeUnit}` : 'Permanent', inline: true },
                    { name: 'Position', value: position.toString(), inline: true }
                );

            if (cooldown) {
                embed.addFields({ 
                    name: 'Cooldown', 
                    value: `${cooldown} ${cooldownUnit}`, 
                    inline: true 
                });
            }
            if (requiredRole) {
                embed.addFields({ name: 'Required Role', value: requiredRole.name, inline: true });
            }

            await interaction.reply({ embeds: [embed], ephemeral: false });
        } else if (subcommand === 'edit') {
            const roleId = interaction.options.getString('product');
            const newPrice = interaction.options.getInteger('price');
            const newRemove = interaction.options.getBoolean('remove');
            const newTime = interaction.options.getInteger('time');
            const newTimeUnit = interaction.options.getString('timeunit') || 'hours';
            const newCooldown = interaction.options.getInteger('cooldown');
            const newCooldownUnit = interaction.options.getString('cooldown_unit') || 'hours';
            const newRequiredRole = interaction.options.getRole('required_role');
            const newPosition = interaction.options.getInteger('position');

            const shopDoc = await db.collection('config').doc('shop').get();
            if (!shopDoc.exists) {
                await interaction.reply({ content: 'Shop configuration not found.', ephemeral: false });
                return;
            }

            const products = shopDoc.data().products || [];
            const productIndex = products.findIndex(p => p.role.id === roleId);

            if (productIndex === -1) {
                await interaction.reply({ content: 'Product not found.', ephemeral: false });
                return;
            }

            const product = products[productIndex];
            const oldProduct = { ...product };

            // Update only the provided fields
            if (newPrice !== null) product.price = newPrice;
            if (newRemove !== null) {
                product.temporary = newRemove;
                if (!newRemove) product.hours = null;
            }
            if (newTime !== null) {
                // Convert time to hours for storage
                product.hours = newTimeUnit === 'minutes' ? newTime / 60 : 
                               newTimeUnit === 'days' ? newTime * 24 : 
                               newTime;
            }
            if (newCooldown !== null) {
                // Convert cooldown to minutes for storage
                const newCooldownMinutes = newCooldownUnit === 'hours' ? newCooldown * 60 : 
                                         newCooldownUnit === 'days' ? newCooldown * 24 * 60 : 
                                         newCooldown;
                product.cooldown = newCooldownMinutes;
                product.cooldownUnit = newCooldownUnit;
            }
            if (newRequiredRole !== null) {
                product.requiredRole = {
                    id: newRequiredRole.id,
                    name: newRequiredRole.name
                };
            }
            if (newPosition !== null) {
                // Update positions of other products if needed
                if (newPosition !== (product.position || 999)) {
                    products.forEach(p => {
                        if (p !== product && p.position >= newPosition) {
                            p.position = (p.position || 0) + 1;
                        }
                    });
                    product.position = newPosition;
                }
            }

            // Validate temporary role settings
            if (product.temporary && !product.hours) {
                await interaction.reply({ 
                    content: 'You must specify the time for temporary roles.',
                    ephemeral: false 
                });
                return;
            }

            // Sort products by position
            products.sort((a, b) => (a.position || 999) - (b.position || 999));

            // Update Firestore
            await db.collection('config').doc('shop').update({ products });

            // Format duration display for both old and new values
            const formatDuration = (hours) => {
                if (hours >= 1) {
                    return `${hours}h`;
                } else {
                    return `${Math.round(hours * 60)}m`;
                }
            };

            const formatCooldown = (minutes, unit) => {
                if (!minutes) return 'None';
                if (unit === 'hours') {
                    const hours = Math.round(minutes / 60);
                    return `${hours} hour${hours === 1 ? '' : 's'}`;
                }
                return `${minutes} minute${minutes === 1 ? '' : 's'}`;
            };

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle('✏️ Product Updated')
                .setDescription(`Successfully updated ${product.role.name}`)
                .addFields(
                    { 
                        name: 'Price', 
                        value: `${oldProduct.price} → ${product.price}`, 
                        inline: true 
                    },
                    { 
                        name: 'Duration', 
                        value: `${oldProduct.temporary ? formatDuration(oldProduct.hours) : 'Permanent'} → ${product.temporary ? formatDuration(product.hours) : 'Permanent'}`, 
                        inline: true 
                    },
                    {
                        name: 'Position',
                        value: `${oldProduct.position || 'None'} → ${product.position || 'None'}`,
                        inline: true
                    }
                );

            if (oldProduct.cooldown || product.cooldown) {
                embed.addFields({
                    name: 'Cooldown',
                    value: `${formatCooldown(oldProduct.cooldown, oldProduct.cooldownUnit || 'hours')} → ${formatCooldown(product.cooldown, product.cooldownUnit || 'hours')}`,
                    inline: true
                });
            }

            if (oldProduct.requiredRole || product.requiredRole) {
                embed.addFields({
                    name: 'Required Role',
                    value: `${oldProduct.requiredRole?.name || 'None'} → ${product.requiredRole?.name || 'None'}`,
                    inline: true
                });
            }

            await interaction.reply({ embeds: [embed], ephemeral: false });
        } else if (subcommand === 'remove') {
            const roleId = interaction.options.getString('product');

            // Get current products
            const shopDoc = await db.collection('config').doc('shop').get();
            if (!shopDoc.exists) {
                await interaction.reply({ content: 'Shop configuration not found.', ephemeral: false });
                return;
            }

            const products = shopDoc.data().products || [];
            const productIndex = products.findIndex(p => p.role.id === roleId);

            if (productIndex === -1) {
                await interaction.reply({ content: 'Product not found.', ephemeral: false });
                return;
            }

            const removedProduct = products[productIndex];
            products.splice(productIndex, 1);

            // Update shop without the removed product
            await db.collection('config').doc('shop').update({ products });

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle('🗑️ Product Removed')
                .setDescription(`Successfully removed ${removedProduct.role.name} from the shop`)
                .addFields(
                    { name: 'Role', value: removedProduct.role.name, inline: true },
                    { name: 'Price', value: `${removedProduct.price} points`, inline: true },
                    { name: 'Duration', value: removedProduct.temporary ? `${removedProduct.hours} hours` : 'Permanent', inline: true }
                );

            if (removedProduct.cooldown) {
                embed.addFields({ name: 'Cooldown', value: `${removedProduct.cooldown} hours`, inline: true });
            }
            if (removedProduct.requiredRole) {
                embed.addFields({ name: 'Required Role', value: removedProduct.requiredRole.name, inline: true });
            }

            await interaction.reply({ embeds: [embed], ephemeral: false });
        }
    } catch (error) {
        console.error('Error managing shop products:', error);
        await interaction.reply({ 
            content: 'An error occurred while managing shop products.',
            ephemeral: false 
        });
    }
}

// Add button interaction handler after the command handlers
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith('buy_')) return;

    try {
        await interaction.deferUpdate();

        const roleId = interaction.customId.replace('buy_', '');
        const shopDoc = await db.collection('config').doc('shop').get();
        const userDoc = await db.collection('users').doc(interaction.user.id).get();
        const currencyName = await getCurrencyName();

        if (!shopDoc.exists || !userDoc.exists) {
            await interaction.editReply({ content: 'Error fetching shop or user data.', components: [], embeds: [] });
            return;
        }

        const products = shopDoc.data().products;
        const product = products.find(p => p.role.id === roleId);
        const userPoints = userDoc.data().points || 0;
        const userDiscount = await getUserDiscount(interaction.member);
        const discountedPrice = Math.floor(product.price * (1 - userDiscount / 100));

        if (!product) {
            await interaction.editReply({ content: 'Product not found.', components: [], embeds: [] });
            return;
        }

        // Check if user already has the role
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.roles.cache.has(product.role.id)) {
            const warningEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚠️ Purchase Failed')
                .setDescription(`You already have the role **${product.role.name}**!`)
                .addFields(
                    { name: `Current ${currencyName.charAt(0).toUpperCase() + currencyName.slice(1)}`, value: `${userPoints}`, inline: true }
                );
            
            await interaction.editReply({ 
                embeds: [warningEmbed],
                components: []
            });
            return;
        }

        if (userPoints < discountedPrice) {  // Check against discounted price
            await interaction.editReply({ 
                content: `You don't have enough ${currencyName}. You need ${discountedPrice} ${currencyName} but have ${userPoints}.`,
                components: [],
                embeds: []
            });
            return;
        }

        // Check bot permissions and role position
        const bot = await interaction.guild.members.fetch(client.user.id);
        
        if (!bot.permissions.has('ManageRoles')) {
            await interaction.editReply({ 
                content: 'Error: Bot does not have permission to manage roles. Please contact an administrator.',
                components: [],
                embeds: []
            });
            return;
        }

        const roleToAssign = await interaction.guild.roles.fetch(product.role.id);
        if (!roleToAssign) {
            await interaction.editReply({ 
                content: 'Error: Role not found. Please contact an administrator.',
                components: [],
                embeds: []
            });
            return;
        }

        if (bot.roles.highest.position <= roleToAssign.position) {
            await interaction.editReply({ 
                content: 'Error: Bot\'s role is not high enough to assign this role. Please contact an administrator.',
                components: [],
                embeds: []
            });
            return;
        }

        // Deduct points (using discounted price) and give role
        const newPoints = userPoints - discountedPrice;  // Use discounted price
        await db.collection('users').doc(interaction.user.id).update({
            points: newPoints
        });

        await member.roles.add(product.role.id);

        // Always update user roles and tier history after a purchase
        await updateUserRoles(member, { points: newPoints, userId: member.id });

        // Send purchase notification to log channel
        await sendPurchaseNotification(member, product, discountedPrice, currencyName, member.guild.id);

        // Handle temporary roles
        if (product.temporary) {
            const expiresAt = Date.now() + (product.hours * 3600000);
            
            // Store temporary role in database
            const tempRolesDoc = await db.collection('config').doc('temporaryRoles').get();
            const roles = tempRolesDoc.exists ? tempRolesDoc.data().roles || [] : [];
            
            await db.collection('config').doc('temporaryRoles').set({
                roles: [...roles, {
                    userId: member.id,
                    guildId: member.guild.id,
                    roleId: product.role.id,
                    roleName: product.role.name,
                    expiresAt: expiresAt
                }]
            });

            setTimeout(async () => {
                try {
                    const member = await interaction.guild.members.fetch(interaction.user.id);
                    await member.roles.remove(product.role.id);
                    await sendRoleExpirationNotification(member, { name: product.role.name }, member.guild.id);
                    // Remove from database
                    const tempRolesDoc = await db.collection('config').doc('temporaryRoles').get();
                    const roles = tempRolesDoc.data().roles || [];
                    await db.collection('config').doc('temporaryRoles').set({
                        roles: roles.filter(r => r.userId !== member.id || r.roleId !== product.role.id)
                    });
                } catch (error) {
                    console.error('Error removing temporary role:', error);
                }
            }, product.hours * 3600000);
        }

        // Find and update the confirmation embed in the button interaction handler
        const confirmEmbed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🛍️ Purchase Successful!')
            .setDescription(`${member.user.tag} has purchased **${product.role.name}**!`)
            .addFields(
                { name: 'Price', value: `${discountedPrice} ${currencyName} ${userDiscount > 0 ? ` (${userDiscount}% off!)` : ''}`, inline: true },
                { name: `Remaining ${currencyName}`, value: `${newPoints} `, inline: true },
                { name: 'Duration', value: product.temporary ? formatDuration(product.hours) : 'Permanent', inline: true }
            )
            .setThumbnail(member.user.displayAvatarURL())
            .setTimestamp();

        await interaction.message.edit({ 
            embeds: [confirmEmbed],
            components: []
        });

        await updateLeaderboard();

    } catch (error) {
        console.error('Error processing purchase:', error);
        await interaction.editReply({ 
            content: 'An error occurred while processing your purchase. Please try again or contact an administrator.',
            components: [],
            embeds: []
        });
    }
});

client.on('error', console.error);
client.login(process.env.BOT_TOKEN); 

async function getStatus(pointsData) {
    try {
        const configDoc = await db.collection('config').doc('tiers').get();
        const settingsDoc = await db.collection('config').doc('settings').get();
        
        const tiers = configDoc.exists ? configDoc.data() : {
            silver: 25,
            gold: 250,
            platinum: 500,
            diamond: 1000
        };

        const retentionSettings = settingsDoc.exists ? 
            settingsDoc.data().tierRetention || { all: 0 } : 
            { all: 0 };

        // Handle both number and object inputs
        const points = typeof pointsData === 'number' ? pointsData : (pointsData.points || 0);
        const userId = typeof pointsData === 'number' ? null : pointsData.userId;

        // Calculate current tier based on points
        const currentTier = calculateBasicStatus(points, tiers);

        // If no retention is enabled or no userId provided, use regular point-based calculation
        if ((!retentionSettings.all && !Object.values(retentionSettings).some(v => v > 0)) || !userId) {
            return currentTier;
        }

        // Get user's tier history
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) return currentTier;

        const userData = userDoc.data();
        const tierHistory = userData.tierHistory || {};
        const now = Date.now();

        // Get valid retained tiers (within retention period)
        const validTiers = Object.entries(tierHistory)
            .filter(([tier, timestamp]) => {
                const retentionDays = retentionSettings.all || retentionSettings[tier] || 0;
                return retentionDays > 0 && (now - timestamp) <= (retentionDays * 24 * 60 * 60 * 1000);
            })
            .map(([tier]) => tier);

        const tierOrder = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
        const currentTierIndex = tierOrder.indexOf(currentTier.toLowerCase());

        // If current tier is not Bronze and either:
        // 1. User doesn't have this tier in history, or
        // 2. The tier in history is expired
        if (currentTier !== 'Bronze') {
            const retentionDays = retentionSettings.all || retentionSettings[currentTier.toLowerCase()] || 0;
            if (retentionDays > 0 && 
                (!tierHistory[currentTier.toLowerCase()] || 
                 (now - tierHistory[currentTier.toLowerCase()]) > (retentionDays * 24 * 60 * 60 * 1000))) {
                console.log(`Setting tier history for ${currentTier} tier at ${now}`);
                await db.collection('users').doc(userId).set({
                    tierHistory: {
                        ...tierHistory,
                        [currentTier.toLowerCase()]: now
                    }
                }, { merge: true });
            }
        }

        // Find the highest retained tier
        const highestRetainedTier = validTiers.reduce((highest, tier) => {
            return tierOrder.indexOf(tier) > tierOrder.indexOf(highest) ? tier : highest;
        }, 'bronze');

        // Return the higher of current tier and retained tier
        const retainedTierIndex = tierOrder.indexOf(highestRetainedTier);
        if (retainedTierIndex > currentTierIndex) {
            console.log(`Using retained tier ${highestRetainedTier} instead of current tier ${currentTier}`);
            return tierOrder[retainedTierIndex].charAt(0).toUpperCase() + 
                   tierOrder[retainedTierIndex].slice(1);
        }

        return currentTier;
    } catch (error) {
        console.error('Error getting status:', error);
        return calculateBasicStatus(typeof pointsData === 'number' ? pointsData : (pointsData.points || 0), {
            silver: 25,
            gold: 250,
            platinum: 500,
            diamond: 1000
        });
    }
}

function calculateBasicStatus(points, tiers) {
    points = Math.max(0, points);
    if (points >= (tiers.diamond || 1000)) return 'Diamond';
    if (points >= (tiers.platinum || 500)) return 'Platinum';
    if (points >= (tiers.gold || 250)) return 'Gold';
    if (points >= (tiers.silver || 25)) return 'Silver';
    return 'Bronze';
}

function getNextStatus(currentStatus) {
    switch (currentStatus) {
        case 'Bronze': return 'Silver';
        case 'Silver': return 'Gold';
        case 'Gold': return 'Platinum';
        case 'Platinum': return 'Diamond';
        default: return 'Diamond';
    }
}

async function getPointsForStatus(status) {
    try {
        const now = Date.now();
        if (CACHE.tiers && (now - CACHE.tiersLastFetch) < CACHE_TTL) {
            const tiers = CACHE.tiers;
            switch (status.toLowerCase()) {
                case 'diamond': return tiers.diamond;
                case 'platinum': return tiers.platinum;
                case 'gold': return tiers.gold;
                case 'silver': return tiers.silver;
                default: return 0;
            }
        }

        const configDoc = await db.collection('config').doc('tiers').get();
        CACHE.tiers = configDoc.exists ? configDoc.data() : {
            silver: 25,
            gold: 250,
            platinum: 500,
            diamond: 1000
        };
        CACHE.tiersLastFetch = now;

        switch (status.toLowerCase()) {
            case 'diamond': return CACHE.tiers.diamond;
            case 'platinum': return CACHE.tiers.platinum;
            case 'gold': return CACHE.tiers.gold;
            case 'silver': return CACHE.tiers.silver;
            default: return 0;
        }
    } catch (error) {
        console.error('Error getting tier points:', error);
        // Fallback to default values if there's an error
        switch (status.toLowerCase()) {
            case 'diamond': return 1000;
            case 'platinum': return 500;
            case 'gold': return 250;
            case 'silver': return 25;
            default: return 0;
        }
    }
}

function generateProgressBar(percent) {
    percent = Math.max(0, Math.min(100, percent)); // Ensure percent is between 0 and 100
    const filledBars = Math.floor(percent / 10);
    const emptyBars = 10 - Math.floor(percent / 10);
    return '█'.repeat(filledBars) + '░'.repeat(emptyBars) + ` ${Math.floor(percent)}%`;
} 

async function handleSetTierCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const tier = interaction.options.getString('tier');
        const points = interaction.options.getInteger('points');

        const configDoc = await db.collection('config').doc('tiers').get();
        const tiers = configDoc.exists ? configDoc.data() : {
            silver: 25,
            gold: 250,
            platinum: 500,
            diamond: 1000
        };

        // Validate tier points are in ascending order
        if (tier === 'silver' && points >= tiers.gold) {
            await interaction.reply({ content: 'Silver tier points must be less than Gold tier points.', ephemeral: false });
            return;
        }
        if (tier === 'gold' && (points <= tiers.silver || points >= tiers.platinum)) {
            await interaction.reply({ content: 'Gold tier points must be between Silver and Platinum tier points.', ephemeral: false });
            return;
        }
        if (tier === 'platinum' && (points <= tiers.gold || points >= tiers.diamond)) {
            await interaction.reply({ content: 'Platinum tier points must be between Gold and Diamond tier points.', ephemeral: false });
            return;
        }
        if (tier === 'diamond' && points <= tiers.platinum) {
            await interaction.reply({ content: 'Diamond tier points must be greater than Platinum tier points.', ephemeral: false });
            return;
        }

        // Update tier points
        await db.collection('config').doc('tiers').set({
            ...tiers,
            [tier]: points
        }, { merge: true });

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('✅ Tier Points Updated')
            .setDescription(`Successfully updated ${tier} tier points requirement.`)
            .addFields(
                { name: 'Tier', value: tier.charAt(0).toUpperCase() + tier.slice(1), inline: true },
                { name: 'Points Required', value: points.toString(), inline: true }
            );

        await interaction.reply({ embeds: [embed], ephemeral: false });

        // Update all users' roles to reflect new tier requirements
        const users = await db.collection('users').get();
        for (const user of users.docs) {
            try {
                const member = await interaction.guild.members.fetch(user.id);
                if (member) {
                    await updateUserRoles(member, user.data().points || 0);
                }
            } catch (error) {
                console.error(`Error updating roles for user ${user.id}:`, error);
            }
        }
    } catch (error) {
        console.error('Error setting tier points:', error);
        await interaction.reply({
            content: 'An error occurred while setting tier points.',
            ephemeral: false
        });
    }
} 

async function handleSetCurrencyCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const newName = interaction.options.getString('name');
        
        // Store the currency name in Firestore
        await db.collection('config').doc('settings').set({
            currencyName: newName
        }, { merge: true });

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('💰 Currency Name Updated')
            .setDescription(`Successfully set the currency name to "${newName}"`);

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error setting currency name:', error);
        await interaction.reply({
            content: 'An error occurred while setting the currency name.',
            ephemeral: false
        });
    }
}

async function getCurrencyName() {
    try {
        const configDoc = await db.collection('config').doc('settings').get();
        return configDoc.exists ? configDoc.data().currencyName || 'points' : 'points';
    } catch (error) {
        console.error('Error getting currency name:', error);
        return 'points';
    }
}

async function handleSetRetentionCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        // Defer the reply immediately to prevent timeout
        await interaction.deferReply({ ephemeral: false });
        
        const tier = interaction.options.getString('tier');
        const days = interaction.options.getInteger('days');
        
        // Get current retention settings
        const settingsDoc = await db.collection('config').doc('settings').get();
        const currentSettings = settingsDoc.exists ? settingsDoc.data() : {};
        
        // Initialize or get current retention settings
        const retentionSettings = currentSettings.tierRetention || {
            all: 0,
            silver: 0,
            gold: 0,
            platinum: 0,
            diamond: 0
        };

        // Update retention settings
        if (tier === 'all') {
            // If setting all tiers, update all values
            Object.keys(retentionSettings).forEach(key => {
                retentionSettings[key] = days;
            });
        } else {
            retentionSettings[tier] = days;
            // If individual tier is being set, make sure 'all' is set to 0
            retentionSettings.all = 0;
        }

        // Store updated retention settings
        await db.collection('config').doc('settings').set({
            tierRetention: retentionSettings,
            lastRetentionUpdate: Date.now()
        }, { merge: true });

        // If any retention is being disabled (set to 0)
        const usersSnapshot = await db.collection('users').get();
        const batch = db.batch();
        const now = Date.now();

        for (const doc of usersSnapshot.docs) {
            const userData = doc.data();
    const points = userData.points || 0;
            const tierHistory = userData.tierHistory || {};
            let updatedTierHistory = { ...tierHistory };

            if (tier === 'all' && days === 0) {
                // If disabling all retention, clear all tier history
                updatedTierHistory = {};
            } else {
                // If specific tier retention is changed
                if (days === 0 && tier !== 'all') {
                    // Remove history for the specific tier being disabled
                    delete updatedTierHistory[tier];
                } else {
                    // Update or add tier history for current tier if points qualify
                    const currentStatus = await calculateBasicStatus(points, {
                        silver: 25,
                        gold: 250,
                        platinum: 500,
                        diamond: 1000
                    });

                    if (points > 0 && 
                        currentStatus.toLowerCase() !== 'bronze' &&
                        (tier === 'all' || currentStatus.toLowerCase() === tier)) {
                        updatedTierHistory[currentStatus.toLowerCase()] = now;
                    }
                }
            }

            // Update user document with new tier history
            const userRef = db.collection('users').doc(doc.id);
            batch.update(userRef, { tierHistory: updatedTierHistory });

            // Update roles if member is in the server
            try {
                const member = await interaction.guild.members.fetch(doc.id);
                if (member) {
                    await updateUserRoles(member, { points: points, userId: doc.id });
                }
            } catch (error) {
                console.error(`Error updating roles for user ${doc.id}:`, error);
            }
        }

        // Commit the batch
        await batch.commit();

        // Create embed showing all retention periods
        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('⏳ Tier Retention Updated')
            .setDescription('Current retention periods:')
            .addFields(
                Object.entries(retentionSettings)
                    .filter(([key]) => key !== 'all' || retentionSettings.all > 0)
                    .map(([key, value]) => ({
                        name: key.charAt(0).toUpperCase() + key.slice(1),
                        value: value === 0 ? 'Disabled' : `${value} days`,
                        inline: true
                    }))
            );

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('Error setting retention period:', error);
        try {
            await interaction.editReply({
                content: 'An error occurred while setting the retention period.',
                ephemeral: false
            });
        } catch (e) {
            console.error('Failed to send error message:', e);
        }
    }
}

async function handleSetBenefitsCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const tier = interaction.options.getString('tier');
        const benefits = [];

        // Collect all provided benefits
        for (let i = 1; i <= 5; i++) {
            const benefit = interaction.options.getString(`benefit${i}`);
            if (benefit) benefits.push(benefit);
        }

        // Store benefits in Firestore
        await db.collection('config').doc('benefits').set({
            [tier]: benefits
        }, { merge: true });

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('✅ Tier Benefits Updated')
            .setDescription(`Successfully updated benefits for ${tier.charAt(0).toUpperCase() + tier.slice(1)} tier`)
            .addFields({
                name: 'Benefits',
                value: benefits.map(b => `• ${b}`).join('\n')
            });

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error setting tier benefits:', error);
        await interaction.reply({
            content: 'An error occurred while setting tier benefits.',
            ephemeral: false
        });
    }
}

async function handleListBenefitsCommand(interaction) {
    try {
        const tierOrder = ['diamond', 'platinum', 'gold', 'silver', 'bronze'];
        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🌟 Tier Benefits')
            .setDescription('Here are the benefits for each tier:');

        // Get benefits from Firestore
        const benefitsDoc = await db.collection('config').doc('benefits').get();
        const storedBenefits = benefitsDoc.exists ? benefitsDoc.data() : {};

        // Add each tier's benefits to the embed
        for (const tier of tierOrder) {
            const benefits = await getTierBenefits(tier.charAt(0).toUpperCase() + tier.slice(1));
            const color = getStatusColor(tier.charAt(0).toUpperCase() + tier.slice(1));
            const emoji = getStatusEmoji(tier.charAt(0).toUpperCase() + tier.slice(1));
            
            embed.addFields({
                name: `${emoji} ${tier.charAt(0).toUpperCase() + tier.slice(1)} Tier`,
                value: benefits,
                inline: false
            });
        }

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error listing tier benefits:', error);
        await interaction.reply({
            content: 'An error occurred while listing tier benefits.',
            ephemeral: false
        });
    }
}

async function handleSetDiscountCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const tier = interaction.options.getString('tier');
        const percent = interaction.options.getInteger('percent');

        // Store discount in Firestore
        await db.collection('config').doc('discounts').set({
            [tier]: percent
        }, { merge: true });

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('💰 Shop Discount Updated')
            .setDescription(`Successfully set ${percent}% discount for ${tier.charAt(0).toUpperCase() + tier.slice(1)} tier`);

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error setting shop discount:', error);
        await interaction.reply({
            content: 'An error occurred while setting the shop discount.',
            ephemeral: false
        });
    }
}

async function getUserDiscount(member) {
    try {
        const discountsDoc = await db.collection('config').doc('discounts').get();
        if (!discountsDoc.exists) return 0;

        // Get user's current points
        const userDoc = await db.collection('users').doc(member.id).get();
        const points = userDoc.exists ? userDoc.data().points || 0 : 0;

        const discounts = discountsDoc.data();
        const status = await getStatus({ points: points, userId: member.id }); // Pass current points
        const discount = discounts[status.toLowerCase()] || 0;

        console.log(`Checking discount for ${member.user.tag} - Status: ${status}, Discount: ${discount}%`);
        return discount;
    } catch (error) {
        console.error('Error getting user discount:', error);
        return 0;
    }
}

async function handleLogChannelCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const channel = interaction.options.getChannel('channel');
        
        // Store the channel ID in Firestore
        await db.collection('config').doc('settings').set({
            logChannelId: channel.id
        }, { merge: true });

        // Update the global logChannel
        logChannel = channel;

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('📝 Log Channel Set')
            .setDescription(`Successfully set ${channel} as the role expiration log channel.`);

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error setting log channel:', error);
        await interaction.reply({
            content: 'An error occurred while setting the log channel.',
            ephemeral: false
        });
    }
}

async function sendRoleExpirationNotification(member, role, guildId) {
    try {
        // If logChannel is not set, try to fetch it
        if (!logChannel) {
            const settingsDoc = await db.collection('config').doc('settings').get();
            const logChannelId = settingsDoc.exists ? settingsDoc.data().logChannelId : null;
            if (logChannelId) {
                try {
                    logChannel = await client.channels.fetch(logChannelId);
                } catch (error) {
                    console.error('Could not fetch log channel:', error);
                }
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0xFF6961)  // Soft red color
            .setTitle('🕒 Temporary Role Expired')
            .setDescription(`${member.user.tag}'s temporary role has expired.`)
            .addFields(
                { name: 'User', value: `<@${member.id}>`, inline: true },
                { name: 'Role', value: role.name, inline: true },
                { name: 'Expired At', value: new Date().toLocaleString(), inline: true }
            )
            .setThumbnail(member.user.displayAvatarURL())
            .setTimestamp();

        if (logChannel) {
            // Send to log channel
            await logChannel.send({ embeds: [embed] });
        } else {
            // Fallback to DM if no log channel is set
            try {
                await member.send({ embeds: [embed] });
            } catch (error) {
                console.error('Could not send DM to user:', error);
            }
        }
    } catch (error) {
        console.error('Error sending role expiration notification:', error);
    }
}

// Add this new function near sendRoleExpirationNotification
async function sendPurchaseNotification(member, product, price, currencyName, guildId) {
    try {
        // If logChannel is not set, try to fetch it
        if (!logChannel) {
            const settingsDoc = await db.collection('config').doc('settings').get();
            const logChannelId = settingsDoc.exists ? settingsDoc.data().logChannelId : null;
            if (logChannelId) {
                try {
                    logChannel = await client.channels.fetch(logChannelId);
                } catch (error) {
                    console.error('Could not fetch log channel:', error);
                }
            }
        }

        // Format duration properly
        const duration = product.temporary ? formatDuration(product.hours) : 'Permanent';

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)  // Same blue color as other embeds
            .setTitle('🛍️ Role Purchased')
            .setDescription(`${member.user.tag} has purchased a role.`)
            .addFields(
                { name: 'User', value: `<@${member.id}>`, inline: true },
                { name: 'Role', value: product.role.name, inline: true },
                { name: 'Price', value: `${price} ${currencyName}`, inline: true },
                { name: 'Duration', value: duration, inline: true }
            )
            .setThumbnail(member.user.displayAvatarURL())
            .setTimestamp();

        if (logChannel) {
            await logChannel.send({ embeds: [embed] });
        }
    } catch (error) {
        console.error('Error sending purchase notification:', error);
    }
}

async function handleMultiTierCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const tier = interaction.options.getString('tier');
        const multiplier = interaction.options.getNumber('multiplier');

        // Store tier multiplier in Firestore
        await db.collection('config').doc('tierMultipliers').set({
            [tier]: multiplier
        }, { merge: true });

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('✨ Tier Multiplier Set')
            .setDescription(`Successfully set point multiplier for ${tier.charAt(0).toUpperCase() + tier.slice(1)} tier`)
            .addFields(
                { name: 'Tier', value: tier.charAt(0).toUpperCase() + tier.slice(1), inline: true },
                { name: 'Multiplier', value: `${multiplier}x`, inline: true }
            );

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error setting tier multiplier:', error);
        await interaction.reply({
            content: 'An error occurred while setting the tier multiplier.',
            ephemeral: false
        });
    }
}

async function handleMultiTierListCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const tierMultipliersDoc = await db.collection('config').doc('tierMultipliers').get();
        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🎯 Tier Point Multipliers')
            .setDescription('Current point multipliers for each tier:');

        const tierOrder = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
        const multipliers = tierMultipliersDoc.exists ? tierMultipliersDoc.data() : {};

        for (const tier of tierOrder) {
            const multiplier = multipliers[tier] || 1;
            const emoji = getStatusEmoji(tier.charAt(0).toUpperCase() + tier.slice(1));
            embed.addFields({
                name: `${emoji} ${tier.charAt(0).toUpperCase() + tier.slice(1)}`,
                value: `${multiplier}x points`,
                inline: true
            });
        }

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error listing tier multipliers:', error);
        await interaction.reply({
            content: 'An error occurred while listing tier multipliers.',
            ephemeral: false
        });
    }
}

async function handleSettingsCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        // Fetch all settings from various collections
        const [
            tiersDoc,
            tierMultipliersDoc,
            settingsDoc,
            benefitsDoc,
            discountsDoc,
            rolesDoc,
            shopDoc,
            multipliersDoc
        ] = await Promise.all([
            db.collection('config').doc('tiers').get(),
            db.collection('config').doc('tierMultipliers').get(),
            db.collection('config').doc('settings').get(),
            db.collection('config').doc('benefits').get(),
            db.collection('config').doc('discounts').get(),
            db.collection('config').doc('roles').get(),
            db.collection('config').doc('shop').get(),
            db.collection('config').doc('multipliers').get()
        ]);

        const settings = settingsDoc.exists ? settingsDoc.data() : {};
        const tiers = tiersDoc.exists ? tiersDoc.data() : {};
        const tierMultipliers = tierMultipliersDoc.exists ? tierMultipliersDoc.data() : {};
        const benefits = benefitsDoc.exists ? benefitsDoc.data() : {};
        const discounts = discountsDoc.exists ? discountsDoc.data() : {};
        const roles = rolesDoc.exists ? rolesDoc.data() : {};
        const products = shopDoc.exists ? shopDoc.data().products || [] : [];
        const multipliers = multipliersDoc.exists ? multipliersDoc.data() : {};

        // Create embeds for different setting categories
        const generalEmbed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('⚙️ Reward System Settings')
            .addFields(
                { name: 'Currency Name', value: settings.currencyName || 'points', inline: true },
                { name: 'Log Channel', value: settings.logChannelId ? `<#${settings.logChannelId}>` : 'Not set', inline: true }
            );

        const tierEmbed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🏆 Tier Settings')
            .addFields(
                { name: 'Points Required', value: 
                    `Bronze: 0\n` +
                    `Silver: ${tiers.silver || '25'}\n` +
                    `Gold: ${tiers.gold || '250'}\n` +
                    `Platinum: ${tiers.platinum || '500'}\n` +
                    `Diamond: ${tiers.diamond || '1000'}`
                },
                { name: 'Tier Multipliers', value: 
                    Object.entries(tierMultipliers)
                        .map(([tier, multi]) => `${tier.charAt(0).toUpperCase() + tier.slice(1)}: ${multi}x`)
                        .join('\n') || 'No tier multipliers set'
                },
                { name: 'Shop Discounts', value:
                    Object.entries(discounts)
                        .map(([tier, discount]) => `${tier.charAt(0).toUpperCase() + tier.slice(1)}: ${discount}%`)
                        .join('\n') || 'No discounts set'
                }
            );

        // Add retention settings if they exist
        if (settings.tierRetention) {
            const retentionField = Object.entries(settings.tierRetention)
                .map(([tier, days]) => `${tier.charAt(0).toUpperCase() + tier.slice(1)}: ${days} days`)
                .join('\n');
            tierEmbed.addFields({ name: 'Tier Retention', value: retentionField || 'No retention settings' });
        }

        const rolesEmbed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('👑 Role Settings')
            .addFields(
                { name: 'Tier Roles', value: 
                    Object.entries(roles)
                        .map(([tier, roleId]) => `${tier.charAt(0).toUpperCase() + tier.slice(1)}: <@&${roleId}>`)
                        .join('\n') || 'No tier roles set'
                }
            );

        // Add shop products summary
        if (products.length > 0) {
            rolesEmbed.addFields({
                name: 'Shop Products', 
                value: `${products.length} products available\n` +
                       `Price Range: ${Math.min(...products.map(p => p.price))} - ${Math.max(...products.map(p => p.price))}`
            });
        }

        // Add active multiplier events if any
        const now = Date.now();
        const activeEvents = multipliers.events?.filter(event => 
            event.start <= now && event.end >= now
        ) || [];

        if (activeEvents.length > 0) {
            const eventsField = activeEvents.map(event => {
                const end = new Date(event.end);
                return `${event.multiplier}x until ${end.toLocaleString()}`;
            }).join('\n');
            generalEmbed.addFields({ name: '🎉 Active Events', value: eventsField });
        }

        await interaction.reply({ embeds: [generalEmbed, tierEmbed, rolesEmbed], ephemeral: false });
    } catch (error) {
        console.error('Error displaying settings:', error);
        await interaction.reply({
            content: 'An error occurred while fetching settings.',
            ephemeral: false
        });
    }
}

// Add this helper function
function formatUsername(user) {
    // If the user has a global name (new Discord username system), use that
    if (user.globalName) {
        return user.globalName;
    }
    // Otherwise use their username, and if it has discriminator, format it properly
    return user.discriminator && user.discriminator !== '0' 
        ? `${user.username}#${user.discriminator}`
        : user.username;
}

async function handleDailyCommand(interaction) {
    try {
        const userId = interaction.user.id;
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        const currencyName = await getCurrencyName();

        // Get daily reward settings
        const settingsDoc = await db.collection('config').doc('settings').get();
        const settings = settingsDoc.exists ? settingsDoc.data() : {};
        const dailyMin = settings.dailyMin || 10;
        const dailyMax = settings.dailyMax || 50;

        // Check if user exists, if not create them
        if (!userDoc.exists) {
            await userRef.set({ points: 0, purchases: [], lastDaily: 0 });
        }

        const userData = userDoc.exists ? userDoc.data() : { lastDaily: 0 };
        const lastDaily = userData.lastDaily || 0;
        const now = Date.now();
        const cooldownHours = 24;
        const cooldownMs = cooldownHours * 60 * 60 * 1000;

        if (now - lastDaily < cooldownMs) {
            const timeLeft = cooldownMs - (now - lastDaily);
            const hoursLeft = Math.floor(timeLeft / (60 * 60 * 1000));
            const minutesLeft = Math.floor((timeLeft % (60 * 60 * 1000)) / (60 * 1000));

            // Thematic cooldown messages
            const cooldownMessages = [
                "In the vast digital wilderness, even Blu must rest. Return when the moon has completed its journey.",
                "The sanctuary awaits your return, but patience is a virtue even in chaos.",
                "Like the cycles of Utopia, all things must wait their time. Your next reward awaits in",
                "The blue moon's blessing requires time to regenerate. Return in",
                "Even the mightiest warriors of Utopia must bide their time. Your next reward becomes available in"
            ];

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle('🌙 The Blue Moon Wanes')
                .setDescription(cooldownMessages[Math.floor(Math.random() * cooldownMessages.length)])
                .addFields(
                    { name: 'Time Until Next Blessing', value: `${hoursLeft}h ${minutesLeft}m`, inline: true }
                );

            await interaction.reply({ embeds: [embed], ephemeral: false });
            return;
        }

        // Calculate random reward
        const reward = Math.floor(Math.random() * (dailyMax - dailyMin + 1)) + dailyMin;

        // Get user's current tier for multiplier
        const status = await getStatus({ points: userData.points || 0, userId });
        const tierMultipliersDoc = await db.collection('config').doc('tierMultipliers').get();
        const tierMultiplier = tierMultipliersDoc.exists ? 
            tierMultipliersDoc.data()[status.toLowerCase()] || 1 : 1;

        // Apply tier multiplier to reward
        const finalReward = Math.floor(reward * tierMultiplier);

        // Thematic reward messages based on tier
        const tierMessages = {
            'Bronze': [
                "You helped Blu the Builder gather wood for the base. He rewards you with",
                "Blu the Farmer taught you how to plant your first seeds. For your help, he gives you",
                "You assisted Blu the Military Strategist in scouting the area. He shares with you"
            ],
            'Silver': [
                "Blu the Builder was impressed by your base design. He rewards your creativity with",
                "Your farming techniques caught Blu the Farmer's eye. He shares his harvest of",
                "Blu the Military Strategist appreciated your combat skills. He awards you"
            ],
            'Gold': [
                "Your expert building skills helped Blu fortify the base. He gratefully shares",
                "Blu the Farmer's crops flourished under your care. He rewards you with",
                "Your strategic mind helped Blu plan a successful raid. Your share of the loot is"
            ],
            'Platinum': [
                "Together with Blu the Builder, you created an impenetrable fortress. Your reward is",
                "Blu the Farmer's automated farm system, built with your help, yielded",
                "Your tactical genius helped Blu secure a major victory. He honors you with"
            ],
            'Diamond': [
                "Blu the Builder considers you a master architect. He presents you with",
                "Your agricultural innovations impressed all three Blus. They reward you with",
                "Blu the Military Strategist names you his second-in-command, granting you"
            ]
        };

        // Cooldown messages
        const cooldownMessages = [
            "Blu the Builder is gathering more resources. Return in",
            "Blu the Farmer's crops need time to grow. Check back in",
            "Blu the Military Strategist is planning the next raid. Come back in",
            "The three Blus are regrouping after battle. Return in",
            "Blu's resource stockpile is replenishing. Wait for"
        ];

        const messages = tierMessages[status] || tierMessages['Bronze'];
        const randomMessage = messages[Math.floor(Math.random() * messages.length)];

        // Create embed for response
        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🌟 Daily Task Completed')
            .setDescription(`${randomMessage} **${finalReward} ${currencyName}**!`)
            .addFields(
                { name: 'Base Reward', value: `${reward} ${currencyName}`, inline: true },
                { name: 'Your Standing', value: status, inline: true }
            );

        // Add multiplier field if applicable
        if (tierMultiplier > 1) {
            embed.addFields(
                { name: 'Power Multiplier', value: `${tierMultiplier}x`, inline: true },
                { name: 'Total Blessing', value: `${finalReward} ${currencyName}`, inline: true }
            );
        }

        // Update user's points and last daily timestamp
        await userRef.update({
            points: admin.firestore.FieldValue.increment(finalReward),
            lastDaily: now
        });

        await interaction.reply({ embeds: [embed], ephemeral: false });

        // Update roles if needed
        const member = interaction.member;
        if (member) {
            const newTotal = (userData.points || 0) + finalReward;
            await updateUserRoles(member, { points: newTotal, userId });
        }

        await updateLeaderboard();
    } catch (error) {
        console.error('Error handling daily command:', error);
        await interaction.reply({
            content: 'The digital wilderness stirs with uncertainty. Try again soon.',
            ephemeral: false
        });
    }
}

async function handleSetDailyCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const min = interaction.options.getInteger('min');
        const max = interaction.options.getInteger('max');

        if (min > max) {
            await interaction.reply({
                content: 'Minimum reward cannot be greater than maximum reward.',
                ephemeral: false
            });
            return;
        }

        // Update daily reward settings
        await db.collection('config').doc('settings').set({
            dailyMin: min,
            dailyMax: max
        }, { merge: true });

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('✅ Daily Reward Updated')
            .setDescription('Successfully updated daily reward settings')
            .addFields(
                { name: 'Minimum Reward', value: min.toString(), inline: true },
                { name: 'Maximum Reward', value: max.toString(), inline: true }
            );

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error setting daily reward:', error);
        await interaction.reply({
            content: 'An error occurred while setting the daily reward.',
            ephemeral: false
        });
    }
}

async function handleCooldownResetCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const targetType = interaction.options.getString('target_type');
        let affectedUsers = [];

        if (targetType === 'user') {
            const user = interaction.options.getUser('target');
            if (!user) {
                await interaction.reply({ content: 'Please specify a user to reset cooldown for.', ephemeral: false });
                return;
            }
            affectedUsers.push(user);
        } else if (targetType === 'role') {
            const role = interaction.options.getRole('role');
            if (!role) {
                await interaction.reply({ content: 'Please specify a role to reset cooldown for.', ephemeral: false });
                return;
            }
            const members = await interaction.guild.members.fetch();
            affectedUsers = members
                .filter(member => member.roles.cache.has(role.id))
                .map(member => member.user);
        }

        if (affectedUsers.length === 0) {
            await interaction.reply({ content: 'No users found to reset cooldown for.', ephemeral: false });
            return;
        }

        // Reset cooldown for all affected users
        const batch = db.batch();
        for (const user of affectedUsers) {
            const userRef = db.collection('users').doc(user.id);
            batch.update(userRef, { lastDaily: 0 });
        }
        await batch.commit();

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🔄 Cooldown Reset')
            .setDescription(`Successfully reset daily cooldown for ${affectedUsers.length} user${affectedUsers.length === 1 ? '' : 's'}`)
            .addFields(
                { 
                    name: 'Affected Users', 
                    value: affectedUsers.length > 10 
                        ? `${affectedUsers.slice(0, 10).map(u => formatUsername(u)).join('\n')}...\nand ${affectedUsers.length - 10} more`
                        : affectedUsers.map(u => formatUsername(u)).join('\n')
                }
            );

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error resetting cooldown:', error);
        await interaction.reply({
            content: 'An error occurred while resetting cooldown.',
            ephemeral: false
        });
    }
}

function formatCooldown(minutes, unit = 'hours') {
    if (!minutes) return 'None';
    
    if (unit === 'days') {
        const days = Math.round(minutes / (60 * 24));
        return `${days} day${days === 1 ? '' : 's'}`;
    }
    if (unit === 'hours') {
        const hours = Math.round(minutes / 60);
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Add after the existing button handler
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    try {
        if (interaction.customId.startsWith('lottery_buy_')) {
            const ticketCount = parseInt(interaction.customId.split('_')[2]);
            await lottery.handleBuyTicketButton(interaction, ticketCount);
        } else if (interaction.customId === 'lottery_mytickets') {
            await lottery.handleMyTicketsButton(interaction);
        } else if (interaction.customId === 'lottery_winners') {
            await lottery.handleWinnersButton(interaction);
        }
    } catch (error) {
        console.error('Error handling lottery button interaction:', error);
        try {
            await interaction.reply({ 
                content: 'An error occurred while processing your request.',
                ephemeral: true 
            });
        } catch (e) {
            console.error('Error sending error message:', e);
        }
    }
});

// Add the new handler function
async function handleCheckGuyCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: true });
        return;
    }

    try {
        const targetUser = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(targetUser.id);
        const userDoc = await db.collection('users').doc(targetUser.id).get();
        const userData = userDoc.exists ? userDoc.data() : { points: 0, purchases: [] };
        const currencyName = await getCurrencyName();

        // Calculate total spent
        const totalSpent = userData.purchases ? userData.purchases.reduce((sum, p) => sum + (p.price || 0), 0) : 0;
        
        // Get status and next tier info
        const status = await getStatus({ points: userData.points || 0, userId: targetUser.id });
        const nextTier = getNextTier(status);
        const nextTierPoints = await getPointsForStatus(nextTier);
        const currentPoints = userData.points || 0;

        // Get tier history
        const tierHistory = userData.tierHistory || {};
        const tierHistoryText = Object.entries(tierHistory)
            .map(([tier, timestamp]) => `${tier.charAt(0).toUpperCase() + tier.slice(1)}: ${new Date(timestamp).toLocaleString()}`)
            .join('\n');

        // Create the embed
        const embed = new EmbedBuilder()
            .setColor(getStatusColor(status))
            .setTitle(`${getStatusEmoji(status)} ${targetUser.username}'s Rewards Status`)
            .setThumbnail(targetUser.displayAvatarURL())
            .addFields(
                { name: 'Current Tier', value: status, inline: true },
                { name: `${currencyName}`, value: currentPoints.toString(), inline: true },
                { name: 'Total Spent', value: `$${totalSpent.toFixed(2)}`, inline: true }
            );

        // Add progress to next tier if not at max tier
        if (nextTier) {
            const pointsNeeded = nextTierPoints - currentPoints;
            const progressBar = generateProgressBar((currentPoints / nextTierPoints) * 100);
            embed.addFields({
                name: `Progress to ${nextTier}`,
                value: `${progressBar}\n${pointsNeeded} ${currencyName} needed`,
                inline: false
            });
        }

        // Add tier history if exists
        if (tierHistoryText) {
            embed.addFields({
                name: 'Tier History',
                value: tierHistoryText,
                inline: false
            });
        }

        // Add benefits for current tier
        const benefits = await getTierBenefits(status);
        if (benefits) {
            embed.addFields({
                name: 'Current Benefits',
                value: benefits,
                inline: false
            });
        }

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error checking user rewards:', error);
        await interaction.reply({
            content: 'An error occurred while checking the user\'s rewards.',
            ephemeral: true
        });
    }
}

// Add this at the top with other collections
const pendingTierDMs = new Map();

async function handleTierDMCommand(interaction) {
    try {
        const tier = interaction.options.getString('tier');

        // Send initial prompt
        const promptEmbed = new EmbedBuilder()
            .setColor(getStatusColor(tier))
            .setTitle('🔔 Set Tier DM Message')
            .setDescription('Please enter the message you want to send when users reach this tier.\n\nAvailable placeholders:')
            .addFields({
                name: 'Placeholders',
                value: [
                    '`{Tier}` - The tier name (e.g., Diamond)',
                    '`{Points}` - Points required for this tier',
                    '`{CurrencyName}` - Your custom currency name',
                    '`{ExpireDate}` - When the tier expires (<t:TIMESTAMP:f>)',
                    '`{ExpireDateRelative}` - Relative time until expiry (<t:TIMESTAMP:R>)',
                    '`{Username}` - The user\'s Discord username',
                    '`{UserMention}` - Mentions the user with @',
                    '`{NextTier}` - The next tier they can achieve',
                    '`{NextTierPoints}` - Points needed for next tier'
                ].join('\n'),
                inline: false
            });

        await interaction.reply({ embeds: [promptEmbed], ephemeral: false });

        // Create message collector
        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, time: 300000, max: 1 }); // 5 minutes timeout

        collector.on('collect', async (message) => {
            try {
                // Delete the user's message to keep things clean
                await message.delete().catch(() => {});

                // Store the DM message template in the database
                await db.collection('config').doc('tierDMs').set({
                    [tier]: message.content
                }, { merge: true });

                // Create a preview of how the message will look
                const nextTier = getNextTier(tier);
                const previewData = {
                    tier: tier.charAt(0).toUpperCase() + tier.slice(1),
                    points: await getPointsForStatus(tier),
                    expireDate: Date.now() + (30 * 24 * 60 * 60 * 1000), // Example: 30 days from now
                    currencyName: await getCurrencyName(),
                    nextTier: nextTier,
                    nextTierPoints: nextTier ? await getPointsForStatus(nextTier) : null
                };

                const preview = replacePlaceholders(message.content, previewData);

                const embed = new EmbedBuilder()
                    .setColor(getStatusColor(tier))
                    .setTitle('✅ Tier DM Set Successfully')
                    .setDescription(`Successfully set the DM message for ${tier} tier!`)
                    .addFields({
                        name: 'Message Preview',
                        value: preview,
                        inline: false
                    });

                await interaction.followUp({ embeds: [embed], ephemeral: false });
            } catch (error) {
                console.error('Error setting tier DM:', error);
                await interaction.followUp({
                    content: 'An error occurred while setting the tier DM message.',
                    ephemeral: true
                });
            }
        });

        collector.on('end', async (collected) => {
            if (collected.size === 0) {
                await interaction.followUp({
                    content: 'Command timed out. Please try again.',
                    ephemeral: true
                });
            }
        });

    } catch (error) {
        console.error('Error starting tier DM setup:', error);
        await interaction.reply({
            content: 'An error occurred while setting up the tier DM message.',
            ephemeral: true
        });
    }
}

// Add this helper function
function replacePlaceholders(message, data) {
    const timestamp = Math.floor(data.expireDate / 1000);
    return message
        .replace(/{Tier}/g, data.tier)
        .replace(/{Points}/g, data.points)
        .replace(/{CurrencyName}/g, data.currencyName)
        .replace(/{ExpireDate}/g, `<t:${timestamp}:f>`)
        .replace(/{ExpireDateRelative}/g, `<t:${timestamp}:R>`)
        .replace(/{Username}/g, '[Username]')
        .replace(/{UserMention}/g, '@Username')
        .replace(/{NextTier}/g, data.nextTier || 'Max Tier')
        .replace(/{NextTierPoints}/g, data.nextTierPoints ? data.nextTierPoints.toString() : 'Max Tier Reached');
}

async function handleDMCommand(interaction) {
    try {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'remove') {
            const tier = interaction.options.getString('tier');

            // Get current DM settings
            const tierDMsDoc = await db.collection('config').doc('tierDMs').get();
            const tierDMs = tierDMsDoc.exists ? tierDMsDoc.data() : {};

            if (!tierDMs[tier]) {
                await interaction.reply({
                    content: `No DM message was set for ${tier} tier.`,
                    ephemeral: false
                });
                return;
            }

            // Remove the DM for this tier
            await db.collection('config').doc('tierDMs').update({
                [tier]: admin.firestore.FieldValue.delete()
            });

            const embed = new EmbedBuilder()
                .setColor(getStatusColor(tier))
                .setTitle('🔕 Tier DM Removed')
                .setDescription(`Successfully removed the DM notification for ${tier} tier.`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed], ephemeral: false });
        }
    } catch (error) {
        console.error('Error handling DM command:', error);
        await interaction.reply({
            content: 'An error occurred while managing tier DMs.',
            ephemeral: true
        });
    }
}

async function handleSetTierUserCommand(interaction) {
    const user = interaction.options.getUser('user');
    const tier = interaction.options.getString('tier');
    const member = await interaction.guild.members.fetch(user.id);

    // Get the user's data
    const userDoc = await db.collection('users').doc(user.id).get();
    const userData = userDoc.exists ? userDoc.data() : { points: 0 };

    // Get the tier points requirements
    const tierPoints = {
        bronze: 0,
        silver: await getPointsForStatus('silver'),
        gold: await getPointsForStatus('gold'),
        platinum: await getPointsForStatus('platinum'),
        diamond: await getPointsForStatus('diamond')
    };

    // Update user's points to match the tier
    userData.points = tierPoints[tier];
    
    // Reset tier history to remove tier lock
    userData.tierHistory = {};
    userData.currentTier = tier.toLowerCase();

    // Update the database
    await db.collection('users').doc(user.id).set(userData, { merge: true });

    // Force update roles with the new tier
    await updateUserRoles(member, { points: userData.points, userId: user.id, forceStatus: tier });

    const embed = new EmbedBuilder()
        .setColor(getStatusColor(tier))
        .setTitle('🔰 Tier Updated')
        .setDescription(`${user}'s tier has been set to **${tier.charAt(0).toUpperCase() + tier.slice(1)}**`)
        .addFields(
            { name: 'Points Set', value: tierPoints[tier].toString(), inline: true },
            { name: 'Tier Lock', value: 'Removed', inline: true }
        );

    await interaction.reply({ embeds: [embed] });
}

async function handlePlistCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    try {
        const shopDoc = await db.collection('config').doc('shop').get();
        if (!shopDoc.exists || !shopDoc.data().products || shopDoc.data().products.length === 0) {
            await interaction.reply({ content: 'No products found in the shop.', ephemeral: false });
            return;
        }

        const products = shopDoc.data().products;
        const currencyName = await getCurrencyName();

        // Sort products by position
        products.sort((a, b) => (a.position || 999) - (b.position || 999));

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('🛍️ Shop Products List')
            .setDescription('All products and their positions in the shop:');

        let productList = '';
        products.forEach((product, index) => {
            const position = product.position || 'None';
            const duration = product.temporary ? `${product.hours}h` : 'Permanent';
            const cooldown = product.cooldown ? 
                (product.cooldownUnit === 'hours' ? `${product.cooldown / 60}h` : 
                 product.cooldownUnit === 'days' ? `${product.cooldown / (24 * 60)}d` : 
                 `${product.cooldown}m`) : 'None';
            const requiredRole = product.requiredRole ? product.requiredRole.name : 'None';

            productList += `**${index + 1}. ${product.role.name}**\n`;
            productList += `Position: ${position} | Price: ${product.price} ${currencyName}\n`;
            productList += `Duration: ${duration} | Cooldown: ${cooldown}\n`;
            productList += `Required Role: ${requiredRole}\n\n`;
        });

        embed.setDescription(productList);

        await interaction.reply({ embeds: [embed], ephemeral: false });
    } catch (error) {
        console.error('Error listing products:', error);
        await interaction.reply({
            content: 'An error occurred while listing products.',
            ephemeral: false
        });
    }
}

async function handlePurchasesCommand(interaction) {
    try {
        const userId = interaction.user.id;
        const userDoc = await db.collection('users').doc(userId).get();
        const currencyName = await getCurrencyName();

        if (!userDoc.exists || !userDoc.data().purchases || userDoc.data().purchases.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle('📜 Purchase History')
                .setDescription('You haven\'t made any purchases yet.')
                .setThumbnail(interaction.user.displayAvatarURL());

            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }

        const userData = userDoc.data();
        const purchases = userData.purchases
            .sort((a, b) => b.timestamp - a.timestamp); // Sort by most recent first

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('📜 Purchase History')
            .setDescription('Here\'s a record of your purchases:')
            .setThumbnail(interaction.user.displayAvatarURL());

        // Split purchases into chunks of 10 for field limits
        const chunks = [];
        for (let i = 0; i < purchases.length; i += 10) {
            chunks.push(purchases.slice(i, i + 10));
        }

        // Add each chunk as a field
        chunks.forEach((chunk, index) => {
            const purchaseText = chunk.map(purchase => {
                const date = new Date(purchase.timestamp).toLocaleString();
                return `${date}: ${purchase.item} ($${purchase.price})`;
            }).join('\n');

            embed.addFields({
                name: index === 0 ? 'Recent Purchases' : '\u200B',
                value: purchaseText,
                inline: false
            });
        });

        // Add total spent field
        const totalSpent = purchases.reduce((sum, purchase) => sum + purchase.price, 0);
        embed.addFields({
            name: 'Total Spent',
            value: `$${totalSpent.toFixed(2)}`,
            inline: true
        });

        await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        console.error('Error displaying purchase history:', error);
        await interaction.reply({
            content: 'An error occurred while retrieving your purchase history.',
            ephemeral: true
        });
    }
}

async function handleSetSpentboardCommand(interaction) {
    spentboardChannel = interaction.channel;
    
    // Store channel ID in Firestore
    await db.collection('config').doc('spentboard').set({
        channelId: spentboardChannel.id
    });

    // Create initial spentboard
    const embed = await generateSpentboard();
    spentboardMessage = await interaction.channel.send({ embeds: [embed] });
    
    // Update Firestore with message ID
    await db.collection('config').doc('spentboard').update({
        messageId: spentboardMessage.id
    });

    await interaction.reply({ 
        content: 'Dynamic purchase leaderboard has been set up in this channel!',
        ephemeral: true 
    });
}

async function updateSpentboard() {
    if (!spentboardChannel || !db) {
        console.log('Skipping spentboard update: Channel or DB not initialized');
        return;
    }

    try {
        console.log('Generating new spentboard...');
        const embed = await generateSpentboard();
        
        if (!spentboardMessage) {
            // Try to fetch the message ID from Firestore
            const configDoc = await db.collection('config').doc('spentboard').get();
            if (configDoc.exists && configDoc.data().messageId) {
                try {
                    spentboardMessage = await spentboardChannel.messages.fetch(configDoc.data().messageId);
                } catch (error) {
                    console.log('Previous spentboard message not found, creating new one');
                }
            }
        }

        if (spentboardMessage) {
            await spentboardMessage.edit({ embeds: [embed] });
            console.log('Existing spentboard message updated');
        } else {
            spentboardMessage = await spentboardChannel.send({ embeds: [embed] });
            await db.collection('config').doc('spentboard').set({
                channelId: spentboardChannel.id,
                messageId: spentboardMessage.id
            });
            console.log('New spentboard message created');
        }
    } catch (error) {
        console.error('Error updating spentboard:', error);
        // Try to recreate the spentboard message if it failed
        try {
            const embed = await generateSpentboard();
            spentboardMessage = await spentboardChannel.send({ embeds: [embed] });
            await db.collection('config').doc('spentboard').set({
                channelId: spentboardChannel.id,
                messageId: spentboardMessage.id
            });
            console.log('Spentboard message recreated after error');
        } catch (retryError) {
            console.error('Failed to recreate spentboard:', retryError);
        }
    }
}

async function generateSpentboard() {
    const userData = await getCachedUserData();
    const currencyName = await getCurrencyName();
    let spentData = [];

    for (const [userId, data] of userData) {
        const totalSpent = (data.purchases || []).reduce((sum, p) => sum + p.price, 0);
        if (totalSpent > 0) {
            spentData.push({
                id: userId,
                spent: totalSpent
            });
        }
    }

    spentData.sort((a, b) => b.spent - a.spent);
    const top10 = spentData.slice(0, 10);

    // Fetch user information for each entry
    const leaderboardFields = [];
    for (const [index, user] of top10.entries()) {
        try {
            const discordUser = await client.users.fetch(user.id);
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
            leaderboardFields.push({
                name: `${medal} ${index + 1}. ${discordUser.username}`,
                value: `$${user.spent.toFixed(2)} spent`,
                inline: false
            });
        } catch (error) {
            console.error(`Error fetching user ${user.id}:`, error);
            leaderboardFields.push({
                name: `${index + 1}. Unknown User`,
                value: `$${user.spent.toFixed(2)} spent`,
                inline: false
            });
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0x59DEFF)
        .setTitle('💰 __Top__ __Spenders__ 💰')
        .setDescription('**Biggest Ballers:**')
        .addFields(leaderboardFields)
        .setTimestamp();

    return embed;
}

async function handleBCommand(interaction) {
    if (interaction.user.id !== '733700705344553001') {
        await interaction.reply({ content: 'This command is only available to the owner.', ephemeral: false });
        return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'edit') {
        try {
            const tier = interaction.options.getString('tier');
            const index = interaction.options.getInteger('index') - 1; // Convert to 0-based index
            const newBenefit = interaction.options.getString('benefit');

            // Get current benefits
            const benefitsDoc = await db.collection('config').doc('benefits').get();
            const benefits = benefitsDoc.exists ? benefitsDoc.data()[tier] || [] : [];

            // Create a copy of the benefits array
            let updatedBenefits = [...benefits];

            if (newBenefit) {
                // Add or update benefit
                while (updatedBenefits.length < index) {
                    updatedBenefits.push(''); // Fill gaps with empty strings
                }
                updatedBenefits[index] = newBenefit;
            } else {
                // Remove benefit
                if (index < updatedBenefits.length) {
                    updatedBenefits.splice(index, 1);
                }
            }

            // Remove empty benefits from the end of the array
            while (updatedBenefits.length > 0 && !updatedBenefits[updatedBenefits.length - 1]) {
                updatedBenefits.pop();
            }

            // Update benefits in Firestore
            await db.collection('config').doc('benefits').set({
                [tier]: updatedBenefits
            }, { merge: true });

            const embed = new EmbedBuilder()
                .setColor(getStatusColor(tier.charAt(0).toUpperCase() + tier.slice(1)))
                .setTitle('✅ Tier Benefit Updated')
                .setDescription(`Successfully updated benefits for ${tier.charAt(0).toUpperCase() + tier.slice(1)} tier`)
                .addFields({
                    name: 'Updated Benefits',
                    value: updatedBenefits.length > 0 ? 
                        updatedBenefits.map((b, i) => `${i + 1}. ${b}`).join('\n') :
                        'No benefits set'
                });

            await interaction.reply({ embeds: [embed], ephemeral: false });
        } catch (error) {
            console.error('Error updating tier benefit:', error);
            await interaction.reply({
                content: 'An error occurred while updating the tier benefit.',
                ephemeral: false
            });
        }
    }
}

// Add at the top with other constants
const CACHE = {
    currencyName: null,
    currencyNameLastFetch: 0,
    tiers: null,
    tiersLastFetch: 0,
    roles: null,
    rolesLastFetch: 0,
    multipliers: null,
    multipliersLastFetch: 0,
    userData: null,
    userDataLastFetch: 0,
    lotteryHistory: null,
    lotteryHistoryLastFetch: 0
};

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const USER_CACHE_TTL = 60 * 1000; // 1 minute
const LEADERBOARD_UPDATE_DELAY = 2 * 60 * 1000; // 2 minutes
let leaderboardUpdateTimeout = null;

// Add function to get cached user data
async function getCachedUserData() {
    const now = Date.now();
    if (CACHE.userData && (now - CACHE.userDataLastFetch) < USER_CACHE_TTL) {
        return CACHE.userData;
    }

    // Query only top users by points and spent
    const [pointsSnapshot, spentSnapshot] = await Promise.all([
        db.collection('users')
            .orderBy('points', 'desc')
            .limit(20)
            .get(),
        db.collection('users')
            .orderBy('totalSpent', 'desc')
            .limit(20)
            .get()
    ]);

    const userData = new Map();
    
    // Process points leaderboard users
    pointsSnapshot.docs.forEach(doc => {
        userData.set(doc.id, doc.data());
    });

    // Add any additional users from spent leaderboard
    spentSnapshot.docs.forEach(doc => {
        if (!userData.has(doc.id)) {
            userData.set(doc.id, doc.data());
        }
    });

    CACHE.userData = userData;
    CACHE.userDataLastFetch = now;
    return userData;
}

// Replace generateLeaderboard function
async function generateLeaderboard(period) {
    const userData = await getCachedUserData();
    const currencyName = await getCurrencyName();
    let leaderboardData = [];

    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

    for (const [userId, data] of userData) {
        let points = 0;

        if (period === 'weekly' || period === 'monthly') {
            const cutoff = period === 'weekly' ? weekAgo : monthAgo;
            points = (data.purchases || [])
                .filter(p => p.timestamp > cutoff)
                .reduce((sum, p) => sum + Math.floor(p.price), 0);
        } else {
            points = data.points || 0;
        }

        if (points > 0) {
            leaderboardData.push({
                id: userId,
                points: points
            });
        }
    }

    leaderboardData.sort((a, b) => b.points - a.points);
    const top10 = leaderboardData.slice(0, 10);

    // Fetch user information for each entry
    const leaderboardFields = [];
    for (const [index, user] of top10.entries()) {
        try {
            const discordUser = await client.users.fetch(user.id);
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
            leaderboardFields.push({
                name: `${medal} ${index + 1}. ${discordUser.username}`,
                value: `${user.points} ${currencyName}`,
                inline: false
            });
        } catch (error) {
            console.error(`Error fetching user ${user.id}:`, error);
            leaderboardFields.push({
                name: `${index + 1}. Unknown User`,
                value: `${user.points} ${currencyName}`,
                inline: false
            });
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0x59DEFF)
        .setTitle(`🏆 __${currencyName}__ __Leaderboard__ 🏆`)
        .setDescription(period === 'alltime' ? '**Top Dogs:**' : 
                       period === 'weekly' ? '**This Week\'s Top Dogs**' : 
                       '**This Month\'s Mega Homies**')
        .addFields(leaderboardFields)
        .setTimestamp();

    return embed;
}

// Replace generateSpentboard function
async function generateSpentboard() {
    const userData = await getCachedUserData();
    const currencyName = await getCurrencyName();
    let spentData = [];

    for (const [userId, data] of userData) {
        const totalSpent = (data.purchases || []).reduce((sum, p) => sum + p.price, 0);
        if (totalSpent > 0) {
            spentData.push({
                id: userId,
                spent: totalSpent
            });
        }
    }

    spentData.sort((a, b) => b.spent - a.spent);
    const top10 = spentData.slice(0, 10);

    // Fetch user information for each entry
    const leaderboardFields = [];
    for (const [index, user] of top10.entries()) {
        try {
            const discordUser = await client.users.fetch(user.id);
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
            leaderboardFields.push({
                name: `${medal} ${index + 1}. ${discordUser.username}`,
                value: `$${user.spent.toFixed(2)} spent`,
                inline: false
            });
        } catch (error) {
            console.error(`Error fetching user ${user.id}:`, error);
            leaderboardFields.push({
                name: `${index + 1}. Unknown User`,
                value: `$${user.spent.toFixed(2)} spent`,
                inline: false
            });
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0x59DEFF)
        .setTitle('💰 __Top__ __Spenders__ 💰')
        .setDescription('**Biggest Ballers:**')
        .addFields(leaderboardFields)
        .setTimestamp();

    return embed;
}

// ... existing code ...

// Add debounced update function
const debouncedUpdateLeaderboard = (() => {
    let timeout;
    return () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
            updateLeaderboard();
        }, LEADERBOARD_UPDATE_DELAY);
    };
})();

async function updateLeaderboard() {
    if (!leaderboardChannel || !db) {
        console.log('Skipping leaderboard update: Channel or DB not initialized');
        return;
    }

    try {
        console.log('Generating new leaderboard...');
        const embed = await generateLeaderboard('alltime');
        
        if (!leaderboardMessage) {
            // Try to fetch the message ID from Firestore
            const configDoc = await db.collection('config').doc('leaderboard').get();
            if (configDoc.exists && configDoc.data().messageId) {
                try {
                    leaderboardMessage = await leaderboardChannel.messages.fetch(configDoc.data().messageId);
                } catch (error) {
                    console.log('Previous leaderboard message not found, creating new one');
                }
            }
        }

        if (leaderboardMessage) {
            await leaderboardMessage.edit({ embeds: [embed] });
            console.log('Existing leaderboard message updated');
        } else {
            leaderboardMessage = await leaderboardChannel.send({ embeds: [embed] });
            await db.collection('config').doc('leaderboard').set({
                channelId: leaderboardChannel.id,
                messageId: leaderboardMessage.id
            });
            console.log('New leaderboard message created');
        }

        // Also update the spentboard if it exists
        if (spentboardChannel) {
            await updateSpentboard();
        }
    } catch (error) {
        console.error('Error updating leaderboard:', error);
        // Try to recreate the leaderboard message if it failed
        try {
            const embed = await generateLeaderboard('alltime');
            leaderboardMessage = await leaderboardChannel.send({ embeds: [embed] });
            await db.collection('config').doc('leaderboard').set({
                channelId: leaderboardChannel.id,
                messageId: leaderboardMessage.id
            });
            console.log('Leaderboard message recreated after error');
        } catch (retryError) {
            console.error('Failed to recreate leaderboard:', retryError);
        }
    }
}

async function handleSlideCommand(interaction) {
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    
    // Don't allow transfers to self or bots
    if (targetUser.id === interaction.user.id) {
        return await interaction.reply({
            content: 'You cannot send points to yourself!',
            ephemeral: true
        });
    }
    if (targetUser.bot) {
        return await interaction.reply({
            content: 'You cannot send points to bots!',
            ephemeral: true
        });
    }

    // Get slide settings
    const settingsDoc = await db.collection('config').doc('slide').get();
    const settings = settingsDoc.exists ? settingsDoc.data() : { min: 1, max: 1000000, tax: 0 };

    // Check amount limits
    if (amount < settings.min || amount > settings.max) {
        return await interaction.reply({
            content: `Transfer amount must be between ${settings.min} and ${settings.max} points!`,
            ephemeral: true
        });
    }

    // Calculate tax if applicable
    const taxRate = settings.tax || 0;
    const taxAmount = Math.floor(amount * (taxRate / 100));
    const transferAmount = amount - taxAmount;

    // Get sender's points
    const senderDoc = await db.collection('users').doc(interaction.user.id).get();
    if (!senderDoc.exists || senderDoc.data().points < amount) {
        return await interaction.reply({
            content: 'You do not have enough points!',
            ephemeral: true
        });
    }

    // Check if recipient exists, create if not
    const recipientRef = db.collection('users').doc(targetUser.id);
    const recipientDoc = await recipientRef.get();
    
    // Perform the transfer in a transaction
    await db.runTransaction(async (transaction) => {
        // Deduct from sender
        transaction.update(db.collection('users').doc(interaction.user.id), {
            points: admin.firestore.FieldValue.increment(-amount)
        });

        // Add to recipient - use set with merge if they don't exist
        if (!recipientDoc.exists) {
            transaction.set(recipientRef, {
                points: transferAmount,
                username: targetUser.username,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
        } else {
            transaction.update(recipientRef, {
                points: admin.firestore.FieldValue.increment(transferAmount)
            });
        }
    });

    const currencyName = await getCurrencyName();
    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💸 Points Transfer')
        .setDescription(`Successfully transferred ${transferAmount} ${currencyName} to ${targetUser}`)
        .addFields(
            { name: 'Amount Sent', value: `${amount} ${currencyName}`, inline: true },
            { name: 'Tax', value: `${taxAmount} ${currencyName} (${taxRate}%)`, inline: true },
            { name: 'Amount Received', value: `${transferAmount} ${currencyName}`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    debouncedUpdateLeaderboard();
}

async function handleSetSlideCommand(interaction) {
    const min = interaction.options.getInteger('min');
    const max = interaction.options.getInteger('max');
    const tax = interaction.options.getInteger('tax') ?? 0;

    if (min > max) {
        return await interaction.reply({
            content: 'Minimum amount cannot be greater than maximum amount!',
            ephemeral: true
        });
    }

    await db.collection('config').doc('slide').set({
        min,
        max,
        tax
    });

    const currencyName = await getCurrencyName();
    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('⚙️ Slide Settings Updated')
        .addFields(
            { name: 'Minimum Amount', value: `${min} ${currencyName}`, inline: true },
            { name: 'Maximum Amount', value: `${max} ${currencyName}`, inline: true },
            { name: 'Tax Rate', value: `${tax}%`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// Add to the command handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        switch (interaction.commandName) {
            // ... existing cases ...
            case 'slide':
                await handleSlideCommand(interaction);
                break;
            case 'setslide':
                await handleSetSlideCommand(interaction);
                break;
            // ... existing code ...
        }
    } catch (error) {
        console.error(`Error handling command ${interaction.commandName}:`, error);
        // Only reply if interaction hasn't been handled yet
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: 'An error occurred while processing your command.',
                ephemeral: true 
            });
        }
    }
});

// Add after other command handlers
async function handleSetPointsCommand(interaction) {
    // Defer reply immediately
    await interaction.deferReply();
    
    const targetType = interaction.options.getString('target_type');
    const points = interaction.options.getInteger('points');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const currencyName = await getCurrencyName();

    if (targetType === 'user') {
        const user = interaction.options.getUser('user');
        if (!user) {
            return await interaction.editReply({
                content: 'Please specify a user!',
                ephemeral: true
            });
        }

        // Update user's points in database
        const userRef = db.collection('users').doc(user.id);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            await userRef.set({
                points: points,
                username: user.username
            });
        } else {
            await userRef.update({
                points: points
            });
        }

        // Update roles if member is in the server
        try {
            const member = await interaction.guild.members.fetch(user.id);
            if (member) {
                await updateUserRoles(member, points);
            }
        } catch (error) {
            console.error('Error updating roles:', error);
        }

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('💰 Points Balance Set')
            .setDescription(`Set points balance for ${user}`)
            .addFields(
                { name: 'New Balance', value: `${points} ${currencyName}`, inline: true },
                { name: 'Reason', value: reason, inline: true }
            )
            .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
        await updateLeaderboard();

    } else if (targetType === 'role') {
        const role = interaction.options.getRole('role');
        if (!role) {
            return await interaction.editReply({
                content: 'Please specify a role!',
                ephemeral: true
            });
        }

        // Get all members with the role
        const members = role.members;
        const batch = db.batch();

        // Update each member's points
        for (const [memberId, member] of members) {
            const userRef = db.collection('users').doc(memberId);
            const userDoc = await userRef.get();

            if (!userDoc.exists) {
                batch.set(userRef, {
                    points: points,
                    username: member.user.username
                });
            } else {
                batch.update(userRef, {
                    points: points
                });
            }

            // Update roles
            await updateUserRoles(member, points);
        }

        // Commit all updates
        await batch.commit();

        const embed = new EmbedBuilder()
            .setColor(0x59DEFF)
            .setTitle('💰 Points Balance Set')
            .setDescription(`Set points balance for all members with role ${role}`)
            .addFields(
                { name: 'New Balance', value: `${points} ${currencyName}`, inline: true },
                { name: 'Members Affected', value: members.size.toString(), inline: true },
                { name: 'Reason', value: reason, inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        await updateLeaderboard();
    }
}

// Add to the command handler switch statement
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        switch (interaction.commandName) {
            // ... existing cases ...
            case 'rsetp':
                await handleSetPointsCommand(interaction);
                break;
            // ... rest of the cases ...
        }
    } catch (error) {
        console.error(`Error handling command ${interaction.commandName}:`, error);
        // Only reply if interaction hasn't been handled yet
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: 'An error occurred while processing your command.',
                ephemeral: true 
            });
        }
    }
});

// Add after other command handlers
async function handleResetCooldownsCommand(interaction) {
    // Check if user has permission to reset cooldowns
    if (!interaction.member.permissions.has('Administrator')) {
        return await interaction.reply({
            content: 'You do not have permission to use this command.',
            ephemeral: true
        });
    }

    // Defer reply immediately
    await interaction.deferReply();
    
    const targetType = interaction.options.getString('target_type');
    console.log('Resetting cooldowns for:', targetType); // Debug log

    try {
        if (targetType === 'all') {
            // Clear all cooldowns from Map
            cooldowns.clear();
            
            // Clear all cooldowns from Firebase
            const cooldownsSnapshot = await db.collection('cooldowns').get();
            const batch = db.batch();
            cooldownsSnapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            
            console.log('Cleared all cooldowns from both Map and Firebase'); // Debug log

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle('🔄 Cooldowns Reset')
                .setDescription('Successfully reset all cooldowns!')
                .addFields(
                    { name: 'Status', value: 'Cleared from memory and database', inline: true },
                    { name: 'Affected Commands', value: gameCommands.join(', '), inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } else {
            const user = interaction.options.getUser('user');
            if (!user) {
                return await interaction.editReply({
                    content: 'Please specify a user!',
                    ephemeral: true
                });
            }

            // Clear user's cooldowns from Map
            for (const key of cooldowns.keys()) {
                if (key.startsWith(user.id)) {
                    cooldowns.delete(key);
                }
            }

            // Clear user's cooldowns from Firebase
            await db.collection('cooldowns').doc(user.id).delete();
            
            console.log(`Cleared cooldowns for user ${user.id} from both Map and Firebase`); // Debug log

            const embed = new EmbedBuilder()
                .setColor(0x59DEFF)
                .setTitle('🔄 Cooldown Reset')
                .setDescription(`Successfully reset cooldowns for ${user}!`)
                .addFields(
                    { name: 'Status', value: 'Cleared from memory and database', inline: true },
                    { name: 'Affected Commands', value: gameCommands.join(', '), inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }
    } catch (error) {
        console.error('Error resetting cooldowns:', error);
        await interaction.editReply({
            content: 'An error occurred while resetting cooldowns.',
            ephemeral: false
        });
    }
}

// Add to the command handler switch statement
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        // Handle resetcooldowns command first
        if (interaction.commandName === 'resetcooldowns') {
            await handleResetCooldownsCommand(interaction);
            return;
        }

        // Check cooldown for game commands
        if (gameCommands.includes(interaction.commandName) && 
            !interaction.member.permissions.has('Administrator')) {
            const cooldownCheck = await checkCooldown(interaction.user.id, interaction.commandName);
            if (cooldownCheck.onCooldown) {
                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('⏳ Cooldown Active')
                    .setDescription(`Please wait ${cooldownCheck.timeLeft} seconds before using game commands again.`)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], ephemeral: true });
                return;
            }
        }

        // Rest of your command handling...
        switch (interaction.commandName) {
            // ... existing cases ...
        }
    } catch (error) {
        console.error(`Error handling command ${interaction.commandName}:`, error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: 'An error occurred while processing your command.',
                ephemeral: false 
            });
        }
    }
});

// Add near the top with other imports and collections
const transactionsRef = db.collection('transactions');

// ... existing code ...

// Update the purchase recording logic
async function handlePurchaseRecord(member, product, price, transactionId, guildId) {
    try {
        // Check if transaction ID already exists
        const transactionDoc = await transactionsRef.doc(transactionId).get();
        if (transactionDoc.exists) {
            console.log(`Transaction ${transactionId} already processed - skipping`);
            return {
                success: false,
                error: 'Transaction already processed'
            };
        }

        // Get user's points data
        const userRef = db.collection('points').doc(member.id);
        const doc = await userRef.get();
        const pointsData = doc.exists ? doc.data() : { points: 0, purchases: [] };

        // Calculate points to award
        const multiplier = await getActiveMultiplier(pointsData);
        const pointsToAward = Math.floor(price * multiplier);

        // Record the transaction first
        await transactionsRef.doc(transactionId).set({
            userId: member.id,
            productName: product,
            price: price,
            pointsAwarded: pointsToAward,
            multiplier: multiplier,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Update user's points and purchases
        const purchase = {
            product: product,
            price: price,
            date: new Date().toISOString(),
            transactionId: transactionId
        };

        await userRef.set({
            points: admin.firestore.FieldValue.increment(pointsToAward),
            purchases: admin.firestore.FieldValue.arrayUnion(purchase),
            totalSpent: admin.firestore.FieldValue.increment(price)
        }, { merge: true });

        // Get currency name for notification
        const currencyName = await getCurrencyName();
        
        // Send purchase notification
        await sendPurchaseNotification(member, product, price, currencyName, guildId);

        return {
            success: true,
            pointsAwarded: pointsToAward,
            multiplier: multiplier
        };
    } catch (error) {
        console.error('Error recording purchase:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Update the command that processes purchases
async function handlePurchasesCommand(interaction) {
    if (!interaction.member.permissions.has('Administrator')) {
        return await interaction.reply({
            content: 'You do not have permission to use this command.',
            ephemeral: true
        });
    }

    await interaction.deferReply();

    const purchases = interaction.options.getString('purchases').trim().split('\n');
    const results = [];
    const errors = [];

    for (const purchase of purchases) {
        try {
            const [userId, productName, priceStr, transactionId] = purchase.split(' ');
            const price = parseFloat(priceStr.replace('USD', ''));

            const member = await interaction.guild.members.fetch(userId);
            if (!member) {
                errors.push(`Could not find member with ID ${userId}`);
                continue;
            }

            const result = await handlePurchaseRecord(member, productName, price, transactionId, interaction.guildId);
            
            if (result.success) {
                results.push({
                    member: member,
                    product: productName,
                    price: price,
                    pointsAwarded: result.pointsAwarded,
                    multiplier: result.multiplier,
                    transactionId: transactionId
                });
            } else {
                if (result.error === 'Transaction already processed') {
                    errors.push(`Transaction ${transactionId} for ${member.user.tag} was already processed - skipped`);
                } else {
                    errors.push(`Error processing purchase for ${member.user.tag}: ${result.error}`);
                }
            }
        } catch (error) {
            console.error('Error processing purchase line:', error);
            errors.push(`Invalid purchase format: ${purchase}`);
        }
    }

    // Create response embed
    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Purchase Processing Results')
        .setTimestamp();

    if (results.length > 0) {
        const successField = results.map(r => 
            `${r.member.user.tag}\n` +
            `Product: ${r.product}\n` +
            `Price: $${r.price}\n` +
            `Points: +${r.pointsAwarded} (${r.multiplier}x)\n` +
            `ID: ${r.transactionId}\n`
        ).join('\n');
        embed.addFields({ name: '✅ Successful Purchases', value: successField });
    }

    if (errors.length > 0) {
        embed.addFields({ name: '❌ Errors', value: errors.join('\n') });
    }

    await interaction.editReply({ embeds: [embed] });
    
    // Update leaderboards after processing purchases
    await updateLeaderboard();
    await updateSpentboard();
}