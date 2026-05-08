const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const sesClient = new SESClient({ region: "ap-southeast-2" });

async function sendEmail(subject = "", html = "") {
  const params = {
    Source: "alerts@mumbr.xyz", // must be verified in SES
    Destination: {
      ToAddresses: ["alerts@mumbr.xyz"],
    },
    Message: {
      Subject: {
        Data: subject,
      },
      Body: {
        Text: {
          Data: html,
        },
        // Optional HTML version
        Html: {
          Data: html,
        },
      },
    },
  };

  try {
    const command = new SendEmailCommand(params);
    const response = await sesClient.send(command);
    console.log("Email sent:", response.MessageId);
  } catch (error) {
    console.error("Error sending email:", error);
  }
}

module.exports = { sendEmail };
