import os
import asyncio
from flask import Flask, request
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CommandHandler, CallbackQueryHandler, ContextTypes

app = Flask(__name__)

# --- CONFIGURATION ---
TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE" 

# Initialize the Bot Application (Global scope to keep it warm if possible)
bot_app = ApplicationBuilder().token(TOKEN).build()

# --- BOT LOGIC (Same as before) ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [
            InlineKeyboardButton("🗿 Rock", callback_data='rock'),
            InlineKeyboardButton("📄 Paper", callback_data='paper'),
            InlineKeyboardButton("✂️ Scissors", callback_data='scissors'),
        ]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text("Choose your weapon:", reply_markup=reply_markup)

async def button_click(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    user_choice = query.data
    import random
    options = ['rock', 'paper', 'scissors']
    bot_choice = random.choice(options)
    emojis = {'rock': '🗿', 'paper': '📄', 'scissors': '✂️'}

    if user_choice == 'play_again':
        keyboard = [[
            InlineKeyboardButton("🗿 Rock", callback_data='rock'),
            InlineKeyboardButton("📄 Paper", callback_data='paper'),
            InlineKeyboardButton("✂️ Scissors", callback_data='scissors'),
        ]]
        await query.edit_message_text("Choose your weapon:", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    if user_choice == bot_choice:
        result = "It's a TIE! 🤝"
    elif (user_choice == 'rock' and bot_choice == 'scissors') or \
         (user_choice == 'paper' and bot_choice == 'rock') or \
         (user_choice == 'scissors' and bot_choice == 'paper'):
        result = "You WIN! 🎉"
    else:
        result = "You LOSE! 💀"

    final_text = (
        f"You chose: {emojis[user_choice]}\n"
        f"Bot chose: {emojis[bot_choice]}\n\n"
        f"<b>{result}</b>"
    )
    
    retry_markup = InlineKeyboardMarkup([[InlineKeyboardButton("🔄 Play Again", callback_data='play_again')]])
    await query.edit_message_text(text=final_text, reply_markup=retry_markup, parse_mode='HTML')

# Register Handlers
bot_app.add_handler(CommandHandler('start', start))
bot_app.add_handler(CallbackQueryHandler(button_click))

# --- VERCEL HANDLER ---
@app.route('/api/webhook', methods=['POST'])
def webhook():
    if request.method == "POST":
        # This converts the text loop into an async loop for Vercel
        asyncio.run(process_update(request.json))
        return "OK"
    return "Bot is running"

async def process_update(json_data):
    await bot_app.initialize()
    # Convert JSON back to a Telegram Update object
    update = Update.de_json(json_data, bot_app.bot)
    await bot_app.process_update(update)

# For local testing (optional)
if __name__ == '__main__':
    app.run(port=3000)
