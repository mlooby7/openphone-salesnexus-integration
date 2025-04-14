// functions/webhook.js

exports.handler = async function(event, context) {
  try {
    // Parse the webhook payload from OpenPhone
    const payload = JSON.parse(event.body);
    console.log("Received webhook from OpenPhone:", JSON.stringify(payload));

    // Extract the phone number from the webhook
    // Make sure to get the correct field based on your OpenPhone webhook structure
    // This might be payload.from, payload.caller, etc.
    let phoneNumber = payload.from || payload.caller || "";
    
    // Format the phone number for SalesNexus search
    // Remove any non-numeric characters and ensure it starts with country code
    phoneNumber = phoneNumber.replace(/\D/g, "");
    if (phoneNumber.length === 10) {
      // Add US country code if missing
      phoneNumber = "1" + phoneNumber;
    }
    
    // Search for the contact in SalesNexus
    const contactId = await findContactByPhoneNumber(phoneNumber);
    
    // Handle different webhook event types from OpenPhone
    if (payload.type === "recording") {
      await handleRecording(payload, contactId);
    } else if (payload.type === "summary") {
      await handleSummary(payload, contactId);
    } else if (payload.type === "transcript") {
      await handleTranscript(payload, contactId);
    } else {
      console.log("Unhandled webhook type:", payload.type);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Unhandled webhook type" })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Webhook processed successfully" })
    };
  } catch (error) {
    console.error("Error processing webhook:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to process webhook" })
    };
  }
};

// Function to find a contact by phone number in SalesNexus
async function findContactByPhoneNumber(phoneNumber) {
  try {
    // Get temporary authorization token (if using permanent API key)
    const authToken = await getAuthToken();
    
    // Define the search request for SalesNexus
    const searchPayload = [{
      "function": "get-contacts",
      "parameters": {
        "login-token": authToken,
        "filter-field": "35", // Phone number field ID
        "filter-value": phoneNumber,
        "page-size": "50"
      }
    }];
    
    // Make the API request to SalesNexus
    const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchPayload)
    });
    
    const result = await response.json();
    console.log("Contact search result:", JSON.stringify(result));
    
    // Check if any contacts were found
    if (result[0].contacts && result[0].contacts.length > 0) {
      return result[0].contacts[0].id; // Return the first matching contact's ID
    }
    
    // Fallback to default contact if no match is found
    console.log("No contact found for phone number:", phoneNumber);
    return process.env.DEFAULT_CONTACT_ID; // Set this in your Netlify environment variables
  } catch (error) {
    console.error("Error finding contact:", error);
    return process.env.DEFAULT_CONTACT_ID; // Fallback to default contact
  }
}

// Function to get authentication token (if using permanent API key)
async function getAuthToken() {
  // If you're using a permanent API key, you might need to convert it to a temporary token
  // Otherwise, return your permanent API key directly
  return process.env.SALESNEXUS_API_KEY;
}

// Handle OpenPhone recording webhook
async function handleRecording(payload, contactId) {
  try {
    // Extract the recording details
    const recordingUrl = payload.recording_url || "";
    const callDate = new Date(payload.timestamp || Date.now()).toLocaleString();
    const callDuration = payload.duration ? `${Math.round(payload.duration / 60)} minutes` : "Unknown duration";
    const callerNumber = payload.from || "Unknown caller";
    
    // Create the note details with the recording information
    const noteDetails = `
OpenPhone Call Recording - ${callDate}
-------------------------------------
Caller: ${callerNumber}
Duration: ${callDuration}
Recording: ${recordingUrl}

Direct link to call in OpenPhone: https://app.openphone.com/calls/${payload.call_id}
`;
    
    // Create the note in SalesNexus
    await createNote(contactId, noteDetails);
  } catch (error) {
    console.error("Error handling recording:", error);
    throw error;
  }
}

// Handle OpenPhone summary webhook
async function handleSummary(payload, contactId) {
  try {
    // Extract the summary details
    const summary = payload.summary || "No summary available";
    const callDate = new Date(payload.timestamp || Date.now()).toLocaleString();
    const callId = payload.call_id || "";
    
    // Create the note details with the summary information
    const noteDetails = `
OpenPhone Call Summary - ${callDate}
------------------------------------
${summary}

Direct link to call in OpenPhone: https://app.openphone.com/calls/${callId}
`;
    
    // Create the note in SalesNexus
    await createNote(contactId, noteDetails);
  } catch (error) {
    console.error("Error handling summary:", error);
    throw error;
  }
}

// Handle OpenPhone transcript webhook
async function handleTranscript(payload, contactId) {
  try {
    // Extract the transcript details
    const transcript = payload.transcript || "No transcript available";
    const callDate = new Date(payload.timestamp || Date.now()).toLocaleString();
    const callId = payload.call_id || "";
    
    // Format the transcript (handle undefined values)
    let formattedTranscript = "No transcript content";
    if (typeof transcript === "string") {
      formattedTranscript = transcript;
    } else if (Array.isArray(transcript)) {
      // If transcript is an array of segments, format them properly
      formattedTranscript = transcript
        .filter(segment => segment && typeof segment.text === "string")
        .map(segment => `${segment.speaker || "Speaker"}: ${segment.text}`)
        .join("\n");
    }
    
    // Create the note details with the transcript information
    const noteDetails = `
OpenPhone Call Transcript - ${callDate}
---------------------------------------
${formattedTranscript}

Direct link to call in OpenPhone: https://app.openphone.com/calls/${callId}
`;
    
    // Create the note in SalesNexus
    await createNote(contactId, noteDetails);
  } catch (error) {
    console.error("Error handling transcript:", error);
    throw error;
  }
}

// Function to create a note in SalesNexus
async function createNote(contactId, details) {
  try {
    // Get authentication token
    const authToken = await getAuthToken();
    
    // Define the note creation payload
    const notePayload = [{
      "function": "create-note",
      "parameters": {
        "login-token": authToken,
        "contact-id": contactId,
        "details": details,
        "type": "call" // You might need to verify the correct type code with SalesNexus
      }
    }];
    
    // Make the API request to SalesNexus
    const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notePayload)
    });
    
    const result = await response.json();
    console.log("Note creation result:", JSON.stringify(result));
    
    // Check for any errors in the response
    if (result[0].error) {
      throw new Error(`SalesNexus API error: ${result[0].error}`);
    }
    
    return result;
  } catch (error) {
    console.error("Error creating note:", error);
    throw error;
  }
}
