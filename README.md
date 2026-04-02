# WooCommerce Subscriptions Dashboard

A simple local dashboard that displays subscription data from your WooCommerce site.

## Setup

1. Ensure your `.env` file contains:
   ```
   WC_URL=https://mindfulscience.es
   WC_KEY=your_consumer_key
   WC_SECRET=your_consumer_secret
   ```

2. Run the server:
   ```
   node server.js
   ```

3. Open http://localhost:3000 in your browser.

## Requirements

- Node.js (no `npm install` needed — uses only built-in modules)
- WooCommerce Subscriptions plugin with REST API enabled
- WooCommerce REST API keys with Read permission
