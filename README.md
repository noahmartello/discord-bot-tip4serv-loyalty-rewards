# Discord Points & Shop Bot

A Discord Bot that tracks Tip4Serv Purchases. Includes a loyalty points system, games, & a shop to spend points!

## Features

- 🎮 Games (Mines, Roulette)
- 💰 Points tracking & shop system
- 🏆 Tier system with roles
- 🎲 Lottery system
- 📊 Dynamic leaderboards
- 💸 Point transfer system
- 📈 Analytics and tracking

## Setup Guide

### 1. Discord Bot Setup
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and name your bot
3. Go to the "Bot" section and click "Add Bot"
4. Enable these privileged intents:
   - Presence Intent
   - Server Members Intent
   - Message Content Intent
5. Copy your bot token (you'll need this later)
6. Go to OAuth2 > URL Generator
   - Select "bot" and "applications.commands"
   - Copy the URL and use it to invite the bot to your server

### 2. Firebase Setup
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project
3. Go to Project Settings > Service Accounts
4. Click "Generate New Private Key"
5. Save the file as `sdk.json` in your bot's folder

### 3. Environment Setup
1. Copy `.env.template` to a new file named `.env`
2. Fill in your values:
   ```
   BOT_TOKEN=your_bot_token_here
   CHANNEL_ID=your_channel_id_here
   CLIENT_ID=your_client_id_here
   GUILD_ID=your_server_id_here
   ```

### 4. Installation
```bash
# Install dependencies
npm install

# Deploy commands
node deploy-commands.js

# Start the bot
node index.js
```

## Core Commands

### Admin Commands
- `/p add` - Add shop items
- `/settier` - Configure tier requirements
- `/setcur` - Set currency name
- `/setrole` - Set tier roles
- `/rgive` - Give points
- `/rtake` - Remove points
- `/multi` - Create point multipliers
- `/rlimits` - Set game betting limits

### User Commands
- `/rewards` - Check your status
- `/shop` - View shop
- `/mines` - Play Mines game
- `/roulette` - Play Roulette
- `/slide` - Transfer points
- `/daily` - Get daily reward

### Games
- **Mines**: Click tiles to find stars and increase your multiplier
- **Roulette**: Bet on various outcomes with different payouts
- **Lottery**: Buy tickets for a chance to win big

## Important Notes

- Make sure to keep your `.env` file and `sdk.json` private
- Never share your bot token or Firebase credentials
- The bot needs administrator permissions to manage roles
- Configure game limits using `/rlimits` before users can play

## Troubleshooting

1. **Command not working?**
   - Make sure you've run `node deploy-commands.js`
   - Check if the bot has proper permissions

2. **Firebase errors?**
   - Verify your `sdk.json` is in the root folder
   - Check if your Firebase project is properly set up

3. **Games not working?**
   - Set up betting limits using `/rlimits`
   - Ensure users have enough points to play 
