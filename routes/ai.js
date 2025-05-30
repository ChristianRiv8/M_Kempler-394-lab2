const express = require('express');
const router = express.Router();
const { OpenAI } = require('openai');
const { query } = require('../db/database');
const authenticateToken = require('../middleware/auth'); // Assuming you have auth middleware

// Initialize OpenAI Client
// Ensure OPENAI_API_KEY is loaded from .env file in server.js or config
let openai;
try {
    openai = new OpenAI(); // Reads OPENAI_API_KEY from process.env by default
} catch (error) {
    console.error('Error initializing OpenAI client:', error.message);
    // Handle the error appropriately, maybe disable AI features
}

// Placeholder Route for Generating Insights
// We'll use POST because it might involve sending context data and triggering an action
router.post('/generate-insights', authenticateToken, async (req, res) => {
    if (!openai) {
        return res.status(503).json({ 
            status: 'error', 
            message: 'AI service is unavailable due to configuration error.' 
        });
    }

    const userId = req.user.id;
    console.log(`Generating insights for user ID: ${userId}`);

    try {
        // 1. Retrieve data for the user (budgets, goals, transactions) from db
        const transactionsPromise = query("SELECT * FROM transactions WHERE user_id = $1 ORDER BY date DESC LIMIT 50", [userId]).then(r => r.rows);

        const budgetsPromise = query("SELECT * FROM budgets WHERE user_id = $1", [userId]).then(r => r.rows);

        const goalsPromise = query(
            "SELECT g.*, COALESCE(SUM(gc.amount), 0) as total_contributed FROM goals g LEFT JOIN goal_contributions gc ON g.id = gc.goal_id WHERE g.user_id = $1 GROUP BY g.id", 
            [userId]
        ).then(r => r.rows);

        const [transactions, budgets, goals] = await Promise.all([
            transactionsPromise,
            budgetsPromise,
            goalsPromise
        ]);

        // 2. Format data and create the prompt for OpenAI
        const financialDataSummary = `
            User ID: ${userId}
            Recent Transactions (last 50):
            ${transactions.map(t => `- ${t.date} | ${t.description} | ${t.category} | Amount: ${t.amount} (${t.type})`).join('\n')}
            
            Active Budgets:
            ${budgets.map(b => `- ${b.category} | Amount: ${b.amount} | Period: ${b.period} | Start Date: ${b.start_date}`).join('\n')}
            
            Financial Goals:
            ${goals.map(g => `- ${g.name} | Target: ${g.target_amount} | Current: ${g.current_amount} (Contributed: ${g.total_contributed || 0}) | Deadline: ${g.deadline} | Type: ${g.type}`).join('\n')}
        `;

        const prompt = `
            You are a friendly and insightful financial advisor AI. 
            Based on the following financial data for a user, provide 3-5 actionable and personalized insights. 
            Focus on spending patterns, budget adherence, goal progress, and potential savings opportunities. 
            For each insight, provide a concise "title", a "content" paragraph explaining the insight, and a "type" (e.g., "spending", "saving", "budget", "goal", "warning", "tip").
            
            Return your response as a VALID JSON array of objects, where each object has "title", "content", and "type" keys. 
            Example: [{"title": "High Spending on Dining Out", "content": "Your spending on dining out has increased by 20% this month compared to your average. Consider...", "type": "spending"}]
            
            Financial Data:
            ${financialDataSummary}
        `;
        
        console.log('OpenAI Prompt:', prompt); // Log the prompt

        // 3. Call OpenAI API (Chat Completions)
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Changed to gpt-4o-mini
            messages: [{ role: "user", content: prompt }],
            // Consider adding response_format: { type: "json_object" } if using a newer model version like gpt-3.5-turbo-1106 or gpt-4-1106-preview
        });

        let insightsResponse = completion.choices[0].message.content;
        console.log('Raw OpenAI Response:', insightsResponse);

        // 4. Parse the response (expecting JSON array of insights)
        let parsedInsights;
        try {
            // Attempt to parse the response directly
            parsedInsights = JSON.parse(insightsResponse);
        } catch (e) {
            // If direct parsing fails, try to extract JSON from a string that might contain triple backticks
            const jsonMatch = insightsResponse.match(/\s*(\[.*\])\s*/s);
            if (jsonMatch && jsonMatch[1]) {
                insightsResponse = jsonMatch[1];
                try {
                    parsedInsights = JSON.parse(insightsResponse);
                } catch (e2) {
                    console.error('Failed to parse JSON even after extracting from backticks:', e2);
                    console.error('Content that failed to parse:', insightsResponse);
                    throw new Error('AI response was not valid JSON after attempting to clean it.');
                }
            } else {
                console.error('Failed to parse JSON, no clear JSON array found:', e);
                console.error('Content that failed to parse:', insightsResponse);
                throw new Error('AI response was not valid JSON.');
            }
        }

        // Ensure it's an array
        if (!Array.isArray(parsedInsights)) {
            console.error('Parsed insights is not an array:', parsedInsights);
            throw new Error('AI response did not result in a JSON array of insights.');
        }

        // Validate structure of each insight object (optional but good practice)
        parsedInsights.forEach(insight => {
            if (!insight.title || !insight.content || !insight.type) {
                console.warn('Malformed insight object:', insight);
                // You could filter these out or throw an error
            }
        });

        // 5. Store insights in the database
        // Delete old insights for the user first
        const deleteResult = await query("DELETE FROM insights WHERE user_id = $1", [userId]);
        console.log(`Deleted ${deleteResult.rowCount} old insights for user ${userId}`);

        // Insert new insights
        const insertedInsights = [];
        for (const insight of parsedInsights) {
            try {
                const insertResult = await query(
                    "INSERT INTO insights (user_id, title, content, type) VALUES ($1, $2, $3, $4) RETURNING id", 
                    [userId, insight.title, insight.content, insight.type]
                );
                if (insertResult.rows.length > 0) {
                    insertedInsights.push({ id: insertResult.rows[0].id, ...insight });
                } else {
                     // Should not happen with RETURNING if insert was successful without error
                    console.warn('Insight insert did not return an ID:', insight);
                }
            } catch (insertErr) {
                console.error('Error inserting insight:', insertErr, 'Insight data:', insight);
                // Decide if you want to stop all or continue. Here, we'll log and continue.
            }
        }
        console.log(`Successfully inserted ${insertedInsights.length} new insights for user ${userId}`);

        res.json({ status: 'success', data: insertedInsights.length > 0 ? insertedInsights : parsedInsights }); // Return inserted or originally parsed

    } catch (error) {
        console.error(`Error generating insights for user ${userId}:`, error);
        // Check for specific OpenAI errors if needed
        if (error.response) {
            console.error('OpenAI API Error Status:', error.response.status);
            console.error('OpenAI API Error Data:', error.response.data);
        }
        res.status(500).json({ status: 'error', message: 'Failed to generate insights' });
    }
});

// GET route to fetch stored insights for a user
router.get('/insights', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await query("SELECT title, content, type, generated_at FROM insights WHERE user_id = $1 ORDER BY generated_at DESC", [userId]);
        res.json({ status: 'success', data: result.rows });
    } catch (error) {
        console.error(`Error in GET /insights for user ${userId}:`, error);
        res.status(500).json({ status: 'error', message: 'Failed to fetch insights' });
    }
});

module.exports = router;