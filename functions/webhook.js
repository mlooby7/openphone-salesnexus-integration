// functions/webhook.js - Basic version

exports.handler = async function(event, context) {
  try {
    // Parse the webhook payload from OpenPhone
    const payload = JSON.parse(event.body);
    console.log("Received webhook from OpenPhone:", JSON.stringify(payload));

    // Get the fallback contact ID from environment variables
    const fallbackContactId = process.env.FALLBACK_CONTACT_ID;

    // Hard-coded Capital One contact ID - replace with the actual ID
    const capitalOneContactId = "9cfa5b07-af10-4dfa-9cb2-a0b0986fc8c7"; // Replace with your Capital One contact ID
    
    // Extract phone numbers
    let toNumber = "";
    
    if (payload.data && payload.data.object) {
      toNumber = payload.data.object.to || "";
    }
    
    console.log(`Call to: ${toNumber}`);
    
    // Very simple logic - if calling Capital One's number, use Capital One contact ID
    let contactId = fallbackContactId;
    
    if (toNumber === "+18884640727") {
      contactId = capitalOneContactId;
      console.log("Capital One number detected, using Capital One contact ID");
    } else {
      console.log("Using fallback contact ID");
    }
    
    // Handle different webhook types
    if (payload.type && payload.type.includes("recording")) {
      await handleRecording(payload, contactId);
    } else if (payload.type && payload.type.includes("summary")) {
      await handleSummary(payload, contactId);
    } else if (payload.type && payload.type.includes("transcript")) {
      await handleTranscript(payload, contactId);
    } else {
      console.log("Unknown webhook type:", payload.type);
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Webhook processed successfully" })
    };
  } catch (error) {
    console.error("Error processing webhook:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// Handle recording webhook
async function handleRecording(payload, contactId) {
  try {
    const callData = payload.data?.object || {};
    const mediaItems = callData.media || [];
    
    // Create note content
    const noteDetails = `
OpenPhone Call Recording
-----------------------
Date: ${new Date(callData.createdAt || Date.now()).toLocaleString()}
From: ${callData.from || "Unknown"}
To: ${callData.to || "Unknown"}
Duration: ${mediaItems.length > 0 ? Math.round(mediaItems[0].duration / 60) + " minutes" : "Unknown"}
Recording URL: ${mediaItems.length > 0 ? mediaItems[0].url : "None"}
`;
    
    // Create note in SalesNexus
    await createNote(contactId, noteDetails);
  } catch (error) {
    console.error("Error handling recording:", error);
  }
}

// Handle summary webhook
async function handleSummary(payload, contactId) {
  try {
    const summaryData = payload.data?.object || {};
    
    // Format summary points
    let summaryText = "No summary available";
    if (summaryData.summary && summaryData.summary.length > 0) {
      summaryText = "Summary:\n- " + summaryData.summary.join("\n- ");
      
      if (summaryData.nextSteps && summaryData.nextSteps.length > 0) {
        summaryText += "\n\nNext Steps:\n- " + summaryData.nextSteps.join("\n- ");
      }
    }
    
    // Create note content
    const noteDetails = `
OpenPhone Call Summary
---------------------
Date: ${new Date(payload.createdAt || Date.now()).toLocaleString()}
${summaryText}
`;
    
    // Create note in SalesNexus
    await createNote(contactId, noteDetails);
  } catch (error) {
    console.error("Error handling summary:", error);
  }
}

// Handle transcript webhook
async function handleTranscript(payload, contactId) {
  try {
    const transcriptData = payload.data?.object || {};
    
    // Format transcript
    let transcriptText = "No transcript available";
    if (transcriptData.dialogue && transcriptData.dialogue.length > 0) {
      transcriptText = transcriptData.dialogue
        .map(segment => `${segment.identifier || "Speaker"}: ${segment.content || ""}`)
        .join("\n");
    }
    
    // Create note content
    const noteDetails = `
OpenPhone Call Transcript
------------------------
Date: ${new Date(payload.createdAt || Date.now()).toLocaleString()}
${transcriptText}
`;
    
    // Create note in SalesNexus
    await createNote(contactId, noteDetails);
  } catch (error) {
    console.error("Error handling transcript:", error);
  }
}

// Create note in SalesNexus
async function createNote(contactId, details) {
  try {
    // Check if we have a valid contact ID
    if (!contactId) {
      console.error("No contact ID provided");
      return;
    }
    
    // Use API key from environment variables
    const apiKey = process.env.SALESNEXUS_API_KEY;
    
    // Create the note payload
    const notePayload = [{
      "function": "create-note",
      "parameters": {
        "login-token": apiKey,
        "contact-id": contactId,
        "details": details,
        "type": 1
      }
    }];
    
    console.log("Creating note for contact:", contactId);
    
    // Make the API request
    const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notePayload)
    });
    
    const result = await response.json();
    console.log("Note creation result:", JSON.stringify(result));
    
    return result;
  } catch (error) {
    console.error("Error creating note:", error);
  }
}
