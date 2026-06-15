const checkAdxTrend = require("./crons/adx.js");

export const handler = async (event, context) => {
  try {
    console.log("Event:", JSON.stringify(event));

    await checkAdxTrend();

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        data,
      }),
    };
  } catch (error) {
    console.error("Lambda Error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message,
      }),
    };
  }
};
