const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();
const mines = require('./mines.js');
const limits = require('./limits.js');
const roulette = require('./roulette.js');

const commands = [
    {
        name: 'rewards',
        description: 'Check your rewards points and status'
    },
    {
        name: 'setrole',
        description: 'Set a role reward for a specific tier',
        default_member_permissions: '8', // Requires administrator permission
        options: [
            {
                name: 'tier',
                description: 'The tier to assign the role to',
                type: 3,
                required: true,
                choices: [
                    { name: 'Bronze', value: 'bronze' },
                    { name: 'Silver', value: 'silver' },
                    { name: 'Gold', value: 'gold' },
                    { name: 'Platinum', value: 'platinum' },
                    { name: 'Diamond', value: 'diamond' }
                ]
            },
            {
                name: 'role',
                description: 'The role to assign',
                type: 8, // ROLE type
                required: true
            }
        ]
    },
    {
        name: 'rgive',
        description: 'Give points to a user or role',
        options: [
            {
                name: 'target_type',
                description: 'Give points to user or role',
                type: 3,
                required: true,
                choices: [
                    { name: 'User', value: 'user' },
                    { name: 'Role', value: 'role' }
                ]
            },
            {
                name: 'points',
                description: 'Number of points to give',
                type: 4,
                required: true,
                min_value: 1
            },
            {
                name: 'user',
                description: 'The user to give points to',
                type: 6,
                required: false
            },
            {
                name: 'role',
                description: 'The role to give points to',
                type: 8,
                required: false
            },
            {
                name: 'reason',
                description: 'Reason for giving points',
                type: 3,
                required: false
            }
        ]
    },
    {
        name: 'rtake',
        description: 'Take points from a user or role',
        default_member_permissions: '8',
        options: [
            {
                name: 'target_type',
                description: 'Take points from user or role',
                type: 3,
                required: true,
                choices: [
                    { name: 'User', value: 'user' },
                    { name: 'Role', value: 'role' }
                ]
            },
            {
                name: 'points',
                description: 'Number of points to take',
                type: 4,
                required: true,
                min_value: 1
            },
            {
                name: 'user',
                description: 'The user to take points from',
                type: 6,
                required: false
            },
            {
                name: 'role',
                description: 'The role to take points from',
                type: 8,
                required: false
            },
            {
                name: 'reason',
                description: 'Reason for taking points',
                type: 3,
                required: false
            }
        ]
    },
    {
        name: 'resetpurchase',
        description: 'Remove a specific purchase from a user',
        default_member_permissions: '8',
        options: [
            {
                name: 'userid',
                description: 'The Discord ID of the user',
                type: 3, // STRING type
                required: true
            },
            {
                name: 'purchase',
                description: 'Select which purchase to remove',
                type: 3, // STRING type
                required: true,
                autocomplete: true
            }
        ]
    },
    {
        name: 'setimage',
        description: 'Set the rewards image for a specific tier',
        default_member_permissions: '8',
        options: [
            {
                name: 'tier',
                description: 'The tier to set the image for',
                type: 3,
                required: true,
                choices: [
                    { name: 'Bronze', value: 'bronze' },
                    { name: 'Silver', value: 'silver' },
                    { name: 'Gold', value: 'gold' },
                    { name: 'Platinum', value: 'platinum' },
                    { name: 'Diamond', value: 'diamond' }
                ]
            },
            {
                name: 'imageurl',
                description: 'The URL of the image to display',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'top',
        description: 'View top spenders',
        default_member_permissions: '8',
        options: [
            {
                name: 'period',
                description: 'Time period for the leaderboard',
                type: 3,
                required: true,
                choices: [
                    { name: 'All Time', value: 'alltime' },
                    { name: 'Weekly', value: 'weekly' },
                    { name: 'Monthly', value: 'monthly' }
                ]
            }
        ]
    },
    {
        name: 'setleaderboard',
        description: 'Set up a dynamic leaderboard in the current channel',
        default_member_permissions: '8'
    },
    {
        name: 'setspentboard',
        description: 'Set up a dynamic purchase leaderboard in the current channel',
        default_member_permissions: '8'
    },
    {
        name: 'checkpurchases',
        description: 'Check a user\'s purchases (Admin only)',
        default_member_permissions: '8',
        options: [
            {
                name: 'userid',
                description: 'The Discord ID of the user to check',
                type: 3, // STRING type
                required: true
            }
        ]
    },
    {
        name: 'sales',
        description: 'View detailed sales analytics',
        options: [
            {
                name: 'period',
                description: 'Time period for analysis',
                type: 3, // STRING type
                required: true,
                choices: [
                    { name: 'Today', value: 'today' },
                    { name: 'Week', value: 'week' },
                    { name: 'Month', value: 'month' },
                    { name: 'All Time', value: 'alltime' }
                ]
            }
        ]
    },
    {
        name: 'bestsellers',
        description: 'View top selling items and analysis',
        options: [
            {
                name: 'period',
                description: 'Time period for analysis',
                type: 3,
                required: true,
                choices: [
                    { name: 'Week', value: 'week' },
                    { name: 'Month', value: 'month' },
                    { name: 'All Time', value: 'alltime' }
                ]
            }
        ]
    },
    {
        name: 'revenue',
        description: 'View detailed revenue breakdown',
        options: [
            {
                name: 'period',
                description: 'Time period for analysis',
                type: 3,
                required: true,
                choices: [
                    { name: 'Today', value: 'today' },
                    { name: 'Week', value: 'week' },
                    { name: 'Month', value: 'month' },
                    { name: 'Year', value: 'year' }
                ]
            },
            {
                name: 'type',
                description: 'Type of items to analyze',
                type: 3,
                required: false,
                choices: [
                    { name: 'All Items', value: 'all' },
                    { name: 'Monthly', value: 'monthly' },
                    { name: 'Weekly', value: 'weekly' },
                    { name: 'Lifetime', value: 'lifetime' },
                    { name: 'Single', value: 'single' }
                ]
            }
        ]
    },
    {
        name: 'multi',
        description: 'Set a point multiplier for a time period',
        default_member_permissions: '8', // Admin only
        options: [
            {
                name: 'multiplier',
                description: 'Point multiplier (e.g., 2 for double points)',
                type: 4, // INTEGER type
                required: true,
                min_value: 1,
                max_value: 10
            },
            {
                name: 'start',
                description: 'Start time in EST (e.g., 2023-12-25 14:00)',
                type: 3, // STRING type
                required: true
            },
            {
                name: 'end',
                description: 'End time in EST (e.g., 2023-12-25 18:00)',
                type: 3, // STRING type
                required: true
            },
            {
                name: 'announcement',
                description: 'Channel to announce the multiplier event (optional)',
                type: 7, // CHANNEL type
                required: false
            }
        ]
    },
    {
        name: 'multilist',
        description: 'List all active and upcoming multiplier events',
        default_member_permissions: '8'
    },
    {
        name: 'multitier',
        description: 'Set point multiplier for a specific tier',
        default_member_permissions: '8',
        options: [
            {
                name: 'tier',
                description: 'The tier to set multiplier for',
                type: 3,
                required: true,
                choices: [
                    { name: 'Bronze', value: 'bronze' },
                    { name: 'Silver', value: 'silver' },
                    { name: 'Gold', value: 'gold' },
                    { name: 'Platinum', value: 'platinum' },
                    { name: 'Diamond', value: 'diamond' }
                ]
            },
            {
                name: 'multiplier',
                description: 'The multiplier value (e.g., 1.5 for 50% bonus)',
                type: 10,
                required: true,
                min_value: 0
            }
        ]
    },
    {
        name: 'multitierlist',
        description: 'List all tier-based point multipliers',
        default_member_permissions: '8'
    },
    {
        name: 'multiremove',
        description: 'Remove a multiplier event',
        default_member_permissions: '8',
        options: [
            {
                name: 'event',
                description: 'Select the multiplier event to remove',
                type: 3, // STRING type
                required: true,
                autocomplete: true
            }
        ]
    },
    {
        name: 'shop',
        description: 'View available items in the rewards shop'
    },
    {
        name: 'p',
        description: 'Manage shop products',
        default_member_permissions: '8',
        options: [
            {
                name: 'add',
                description: 'Add a new product to the shop',
                type: 1,
                options: [
                    {
                        name: 'role',
                        description: 'The role to sell',
                        type: 8,
                        required: true
                    },
                    {
                        name: 'price',
                        description: 'The price in points',
                        type: 4,
                        required: true,
                        min_value: 1
                    },
                    {
                        name: 'remove',
                        description: 'Whether the role should be removed after a time',
                        type: 5,
                        required: false
                    },
                    {
                        name: 'time',
                        description: 'Time in hours/minutes before role is removed',
                        type: 4,
                        required: false,
                        min_value: 1
                    },
                    {
                        name: 'timeunit',
                        description: 'Unit of time for role removal',
                        type: 3,
                        required: false,
                        choices: [
                            { name: 'Minutes', value: 'minutes' },
                            { name: 'Hours', value: 'hours' },
                            { name: 'Days', value: 'days' }
                        ]
                    },
                    {
                        name: 'cooldown',
                        description: 'Cooldown before role can be purchased again',
                        type: 4,
                        required: false,
                        min_value: 1
                    },
                    {
                        name: 'cooldown_unit',
                        description: 'Unit of time for cooldown',
                        type: 3,
                        required: false,
                        choices: [
                            { name: 'Minutes', value: 'minutes' },
                            { name: 'Hours', value: 'hours' },
                            { name: 'Days', value: 'days' }
                        ]
                    },
                    {
                        name: 'required_role',
                        description: 'Role required to purchase this product',
                        type: 8,
                        required: false
                    },
                    {
                        name: 'position',
                        description: 'Position in the shop (0 = first, 1 = second, etc.)',
                        type: 4,
                        required: false,
                        min_value: 0
                    }
                ]
            },
            {
                name: 'edit',
                description: 'Edit an existing product',
                type: 1,
                options: [
                    {
                        name: 'product',
                        description: 'The product to edit',
                        type: 3,
                        required: true,
                        autocomplete: true
                    },
                    {
                        name: 'price',
                        description: 'The new price in points',
                        type: 4,
                        required: false,
                        min_value: 1
                    },
                    {
                        name: 'remove',
                        description: 'Whether the role should be removed after a time',
                        type: 5,
                        required: false
                    },
                    {
                        name: 'time',
                        description: 'Time in hours/minutes before role is removed',
                        type: 4,
                        required: false,
                        min_value: 1
                    },
                    {
                        name: 'timeunit',
                        description: 'Unit of time for role removal',
                        type: 3,
                        required: false,
                        choices: [
                            { name: 'Minutes', value: 'minutes' },
                            { name: 'Hours', value: 'hours' },
                            { name: 'Days', value: 'days' }
                        ]
                    },
                    {
                        name: 'cooldown',
                        description: 'Cooldown before role can be purchased again',
                        type: 4,
                        required: false,
                        min_value: 1
                    },
                    {
                        name: 'cooldown_unit',
                        description: 'Unit of time for cooldown',
                        type: 3,
                        required: false,
                        choices: [
                            { name: 'Minutes', value: 'minutes' },
                            { name: 'Hours', value: 'hours' },
                            { name: 'Days', value: 'days' }
                        ]
                    },
                    {
                        name: 'required_role',
                        description: 'Role required to purchase this product',
                        type: 8,
                        required: false
                    },
                    {
                        name: 'position',
                        description: 'Position in the shop (0 = first, 1 = second, etc.)',
                        type: 4,
                        required: false,
                        min_value: 0
                    }
                ]
            },
            {
                name: 'remove',
                description: 'Remove a product from the shop',
                type: 1,
                options: [
                    {
                        name: 'product',
                        description: 'The product to remove',
                        type: 3,
                        required: true,
                        autocomplete: true
                    }
                ]
            }
        ]
    },
    {
        name: 'plist',
        description: 'View all products and their positions in the shop',
        default_member_permissions: '8'
    },
    {
        name: 'settier',
        description: 'Set the points required for each tier',
        default_member_permissions: '8',
        options: [
            {
                name: 'tier',
                description: 'The tier to modify',
                type: 3,
                required: true,
                choices: [
                    { name: 'Silver', value: 'silver' },
                    { name: 'Gold', value: 'gold' },
                    { name: 'Platinum', value: 'platinum' },
                    { name: 'Diamond', value: 'diamond' }
                ]
            },
            {
                name: 'points',
                description: 'Points required to reach this tier',
                type: 4,
                required: true,
                min_value: 1
            }
        ]
    },
    {
        name: 'setcur',
        description: 'Set the custom currency name',
        default_member_permissions: '8',
        options: [
            {
                name: 'name',
                description: 'The new name for the currency (e.g., coins, credits)',
                type: 3,
                required: true
            }
        ]
    },
    {
        name: 'setretention',
        description: 'Set the tier retention period',
        default_member_permissions: '8',
        options: [
            {
                name: 'tier',
                description: 'The tier to set retention for',
                type: 3,
                required: true,
                choices: [
                    { name: 'All Tiers', value: 'all' },
                    { name: 'Silver', value: 'silver' },
                    { name: 'Gold', value: 'gold' },
                    { name: 'Platinum', value: 'platinum' },
                    { name: 'Diamond', value: 'diamond' }
                ]
            },
            {
                name: 'days',
                description: 'Number of days to retain the tier (0 to disable)',
                type: 4,
                required: true,
                min_value: 0,
                max_value: 365
            }
        ]
    },
    {
        name: 'setbenefits',
        description: 'Set the benefits for a specific tier',
        default_member_permissions: '8',
        options: [
            {
                name: 'tier',
                description: 'The tier to set benefits for',
                type: 3,
                required: true,
                choices: [
                    { name: 'Bronze', value: 'bronze' },
                    { name: 'Silver', value: 'silver' },
                    { name: 'Gold', value: 'gold' },
                    { name: 'Platinum', value: 'platinum' },
                    { name: 'Diamond', value: 'diamond' }
                ]
            },
            {
                name: 'benefit1',
                description: 'First benefit',
                type: 3,
                required: true
            },
            {
                name: 'benefit2',
                description: 'Second benefit',
                type: 3,
                required: false
            },
            {
                name: 'benefit3',
                description: 'Third benefit',
                type: 3,
                required: false
            },
            {
                name: 'benefit4',
                description: 'Fourth benefit',
                type: 3,
                required: false
            },
            {
                name: 'benefit5',
                description: 'Fifth benefit',
                type: 3,
                required: false
            }
        ]
    },
    {
        name: 'listbenefits',
        description: 'View all tier benefits'
    },
    {
        name: 'setdiscount',
        description: 'Set shop discount for a specific tier',
        default_member_permissions: '8',
        options: [
            {
                name: 'tier',
                description: 'The tier to set discount for',
                type: 3,
                required: true,
                choices: [
                    { name: 'Bronze', value: 'bronze' },
                    { name: 'Silver', value: 'silver' },
                    { name: 'Gold', value: 'gold' },
                    { name: 'Platinum', value: 'platinum' },
                    { name: 'Diamond', value: 'diamond' }
                ]
            },
            {
                name: 'percent',
                description: 'Discount percentage (0-100)',
                type: 4,
                required: true,
                min_value: 0,
                max_value: 100
            }
        ]
    },
    {
        name: 'logchan',
        description: 'Set the channel for role expiration logs',
        default_member_permissions: '8',
        options: [
            {
                name: 'channel',
                description: 'The channel to send role expiration logs to',
                type: 7,
                required: true,
                channel_types: [0]
            }
        ]
    },
    {
        name: 'settings',
        description: 'View all current reward system settings',
        default_member_permissions: '8'
    },
    {
        name: 'cdreset',
        description: 'Reset daily cooldown for a user or role',
        default_member_permissions: '8',
        options: [
            {
                name: 'target_type',
                description: 'Reset cooldown for user or role',
                type: 3,
                required: true,
                choices: [
                    { name: 'User', value: 'user' },
                    { name: 'Role', value: 'role' }
                ]
            },
            {
                name: 'target',
                description: 'The user or role to reset cooldown for',
                type: 6,  // USER type
                required: false
            },
            {
                name: 'role',
                description: 'The role to reset cooldown for',
                type: 8,  // ROLE type
                required: false
            }
        ]
    },
    {
        name: 'daily',
        description: 'Claim your daily points reward'
    },
    {
        name: 'setdaily',
        description: 'Set the daily reward range',
        default_member_permissions: '8',
        options: [
            {
                name: 'min',
                description: 'Minimum points for daily reward',
                type: 4,
                required: true,
                min_value: 1
            },
            {
                name: 'max',
                description: 'Maximum points for daily reward',
                type: 4,
                required: true,
                min_value: 1
            }
        ]
    },
    {
        name: 'setlotto',
        description: 'Set up a new lottery',
        default_member_permissions: '8',
        options: [
            {
                name: 'type',
                description: 'Type of lottery',
                type: 3,
                required: true,
                choices: [
                    { name: 'Daily Draw', value: 'DAILY' },
                    { name: 'Weekly Jackpot', value: 'WEEKLY' },
                    { name: 'Special Event', value: 'SPECIAL' }
                ]
            },
            {
                name: 'ticket_price',
                description: 'Price per ticket in points',
                type: 4,
                required: true,
                min_value: 1
            },
            {
                name: 'max_tickets',
                description: 'Maximum tickets per user',
                type: 4,
                required: true,
                min_value: 1
            },
            {
                name: 'winners',
                description: 'Number of winners to draw',
                type: 4,
                required: true,
                min_value: 1
            },
            {
                name: 'duration',
                description: 'Duration of the lottery',
                type: 4,
                required: true,
                min_value: 1
            },
            {
                name: 'duration_unit',
                description: 'Unit of time for duration',
                type: 3,
                required: true,
                choices: [
                    { name: 'Minutes', value: 'minutes' },
                    { name: 'Hours', value: 'hours' },
                    { name: 'Days', value: 'days' }
                ]
            },
            {
                name: 'starting_jackpot',
                description: 'Starting jackpot amount (defaults to 10)',
                type: 4,
                required: false,
                min_value: 1
            }
        ]
    },
    {
        name: 'listlotto',
        description: 'List all active and past lotteries',
        default_member_permissions: '8'
    },
    {
        name: 'removelotto',
        description: 'Remove an active lottery',
        default_member_permissions: '8',
        options: [
            {
                name: 'lottery',
                description: 'Select the lottery to remove',
                type: 3,
                required: true,
                autocomplete: true
            }
        ]
    },
    {
        name: 'checkguy',
        description: 'Check rewards status of another user',
        default_member_permissions: '8',
        options: [
            {
                name: 'user',
                description: 'The user to check',
                type: 6, // USER type
                required: true
            }
        ]
    },
    {
        name: 'tierdm',
        description: 'Set the DM message for when users reach a specific tier',
        default_member_permissions: '8',
        options: [
            {
                name: 'tier',
                description: 'The tier to set the DM for',
                type: 3,
                required: true,
                choices: [
                    { name: 'Bronze', value: 'bronze' },
                    { name: 'Silver', value: 'silver' },
                    { name: 'Gold', value: 'gold' },
                    { name: 'Platinum', value: 'platinum' },
                    { name: 'Diamond', value: 'diamond' }
                ]
            }
        ]
    },
    {
        name: 'dm',
        description: 'Manage tier DM notifications',
        default_member_permissions: '8',
        options: [
            {
                name: 'remove',
                description: 'Remove DM notification for a tier',
                type: 1,
                options: [
                    {
                        name: 'tier',
                        description: 'The tier to stop sending DMs for',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Bronze', value: 'bronze' },
                            { name: 'Silver', value: 'silver' },
                            { name: 'Gold', value: 'gold' },
                            { name: 'Platinum', value: 'platinum' },
                            { name: 'Diamond', value: 'diamond' }
                        ]
                    }
                ]
            }
        ]
    },
    {
        name: 'settieruser',
        description: 'Manually set a user\'s tier',
        default_member_permissions: '8',
        options: [
            {
                name: 'user',
                description: 'The user to set the tier for',
                type: 6,
                required: true
            },
            {
                name: 'tier',
                description: 'The tier to set',
                type: 3,
                required: true,
                choices: [
                    { name: 'Bronze', value: 'bronze' },
                    { name: 'Silver', value: 'silver' },
                    { name: 'Gold', value: 'gold' },
                    { name: 'Platinum', value: 'platinum' },
                    { name: 'Diamond', value: 'diamond' }
                ]
            }
        ]
    },
    mines.data,
    limits.data,
    roulette.data,
    {
        name: 'rsetp',
        description: 'Set points balance for a user or role',
        default_member_permissions: '8', // Admin only
        options: [
            {
                name: 'target_type',
                description: 'Set points for user or role',
                type: 3,
                required: true,
                choices: [
                    { name: 'User', value: 'user' },
                    { name: 'Role', value: 'role' }
                ]
            },
            {
                name: 'points',
                description: 'New points balance to set',
                type: 4,
                required: true,
                min_value: 0
            },
            {
                name: 'user',
                description: 'The user to set points for',
                type: 6,
                required: false
            },
            {
                name: 'role',
                description: 'The role to set points for',
                type: 8,
                required: false
            },
            {
                name: 'reason',
                description: 'Reason for setting points',
                type: 3,
                required: false
            }
        ]
    },
    {
        name: 'b',
        description: 'Manage tier benefits',
        default_member_permissions: '8',
        options: [
            {
                name: 'edit',
                description: 'Edit a specific benefit for a tier',
                type: 1,
                options: [
                    {
                        name: 'tier',
                        description: 'The tier to edit benefits for',
                        type: 3,
                        required: true,
                        choices: [
                            { name: 'Bronze', value: 'bronze' },
                            { name: 'Silver', value: 'silver' },
                            { name: 'Gold', value: 'gold' },
                            { name: 'Platinum', value: 'platinum' },
                            { name: 'Diamond', value: 'diamond' }
                        ]
                    },
                    {
                        name: 'index',
                        description: 'The benefit number to edit (1-5)',
                        type: 4,
                        required: true,
                        min_value: 1,
                        max_value: 5
                    },
                    {
                        name: 'benefit',
                        description: 'The new benefit text (leave empty to remove)',
                        type: 3,
                        required: false
                    }
                ]
            }
        ]
    },
    {
        name: 'slide',
        description: 'Transfer points to another user',
        options: [
            {
                name: 'user',
                description: 'The user to send points to',
                type: 6, // USER type
                required: true
            },
            {
                name: 'amount',
                description: 'Amount of points to send',
                type: 4, // INTEGER type
                required: true,
                min_value: 1
            }
        ]
    },
    {
        name: 'setslide',
        description: 'Configure slide command settings',
        default_member_permissions: '8', // Admin only
        options: [
            {
                name: 'min',
                description: 'Minimum amount that can be transferred',
                type: 4, // INTEGER type
                required: true,
                min_value: 1
            },
            {
                name: 'max',
                description: 'Maximum amount that can be transferred',
                type: 4, // INTEGER type
                required: true,
                min_value: 1
            },
            {
                name: 'tax',
                description: 'Tax percentage on transfers (0-100)',
                type: 4, // INTEGER type
                required: false,
                min_value: 0,
                max_value: 100
            }
        ]
    },
    {
        name: 'resetcooldowns',
        description: 'Reset game cooldowns for a user or all users',
        default_member_permissions: '8', // Admin only
        options: [
            {
                name: 'target_type',
                description: 'Reset cooldowns for specific user or all users',
                type: 3,
                required: true,
                choices: [
                    { name: 'User', value: 'user' },
                    { name: 'All Users', value: 'all' }
                ]
            },
            {
                name: 'user',
                description: 'The user to reset cooldowns for',
                type: 6,
                required: false
            }
        ]
    }
];

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})(); 