// functions/webhook.js

exports.handler = async function(event, context) {
  try {
    // Parse the webhook payload from OpenPhone
    const payload = JSON.parse(event.body);
    console.log("Received webhook from OpenPhone:", JSON.stringify(payload));

    // Extract information about the call
    let callId = "";
    let phoneNumbers = { from: "", to: "" };
    
    // The structure of the payload differs by webhook type
    // Extract data based on the webhook type
    if (payload.type && payload.type.includes("recording")) {
      // Recording webhooks have the call details directly in data.object
      if (payload.data && payload.data.object) {
        callId = payload.data.object.id || "";
        phoneNumbers.from = payload.data.object.from || "";
        phoneNumbers.to = payload.data.object.to || "";
      }
    } else if (payload.type && payload.type.includes("transcript")) {
      // Transcript webhooks have the callId in data.object.callId
      if (payload.data && payload.data.object) {
        callId = payload.data.object.callId || "";
        
        // We need to store the phone numbers for later webhook events
        // Since transcript events don't include the phone numbers
        await storeCallDetails(callId, phoneNumbers);
      }
    } else if (payload.type && payload.type.includes("summary")) {
      // Summary webhooks also have the callId in data.object.callId
      if (payload.data && payload.data.object) {
        callId = payload.data.object.callId || "";
      }
    }
    
    console.log(`Processing call ID: ${callId}`);
    console.log(`Phone numbers - From: ${phoneNumbers.from}, To: ${phoneNumbers.to}`);
    
    // If we don't have phone numbers yet (transcript/summary), try to retrieve them
    if ((!phoneNumbers.from || !phoneNumbers.to) && callId) {
      console.log("Retrieving stored call details");
      const storedDetails = await retrieveCallDetails(callId);
      if (storedDetails && storedDetails.from && storedDetails.to) {
        phoneNumbers = storedDetails;
        console.log(`Retrieved phone numbers - From: ${phoneNumbers.from}, To: ${phoneNumbers.to}`);
      }
    }
    
    // Determine which phone number to use for contact matching
    // For outgoing calls (from your OpenPhone number), use the "to" number
    // For incoming calls (to your OpenPhone number), use the "from" number
    const direction = payload.data?.object?.direction || "outgoing";
    const lookupNumber = direction === "outgoing" ? phoneNumbers.to : phoneNumbers.from;
    
    console.log(`Using ${lookupNumber} to look up contact`);
    
    // Default to fallback contact ID
    let contactId = process.env.FALLBACK_CONTACT_ID;
    
    // If we have a phone number to look up, try to find the contact
    if (lookupNumber) {
      try {
        // Find the contact in SalesNexus
        contactId = await findContactByPhoneNumber(lookupNumber) || process.env.FALLBACK_CONTACT_ID;
      } catch (error) {
        console.error("Error finding contact:", error);
      }
    }
    
    console.log(`Using contact ID: ${contactId}`);
    
    // Handle different webhook event types from OpenPhone
    const webhookType = payload.type || "";
    
    if (webhookType.includes("recording")) {
      await handleRecording(payload, contactId);
      
      // Store the call details for later webhook events
      await storeCallDetails(callId, phoneNumbers);
    } else if (webhookType.includes("summary")) {
      await handleSummary(payload, contactId);
    } else if (webhookType.includes("transcript")) {
      await handleTranscript(payload, contactId);
    } else {
      console.log("Unhandled webhook type:", webhookType);
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

// Simple in-memory store for call details
// In a production environment, you might want to use a database
const callDetailsStore = {};

// Store call details for later webhook events
async function storeCallDetails(callId, phoneNumbers) {
  if (!callId) return;
  
  console.log(`Storing call details for call ID: ${callId}`);
  callDetailsStore[callId] = phoneNumbers;
  
  // Clean up old entries to prevent memory leaks
  // Keep only the 100 most recent entries
  const callIds = Object.keys(callDetailsStore);
  if (callIds.length > 100) {
    const oldestCallId = callIds[0];
    delete callDetailsStore[oldestCallId];
  }
}

// Retrieve stored call details
async function retrieveCallDetails(callId) {
  if (!callId) return null;
  
  return callDetailsStore[callId] || null;
}

// Find a contact in SalesNexus by phone number
async function findContactByPhoneNumber(phoneNumber) {
  if (!phoneNumber) {
    console.log("No phone number provided for lookup");
    return null;
  }
  
  // Clean the phone number to ensure consistent format
  // Remove non-numeric characters and ensure E.164 format
  let cleanNumber = phoneNumber.replace(/\D/g, "");
  
  // If it starts with a country code, make sure it's included
  if (cleanNumber.length === 10) {
    cleanNumber = "1" + cleanNumber; // Add US country code if missing
  }
  
  console.log(`Searching for contact with number: ${cleanNumber}`);
  
  try {
    // Get the API key
    const apiKey = process.env.SALESNEXUS_API_KEY;
    
    // Use the SalesNexus get-contacts API with filter-field for phone number
    const searchPayload = [{
      "function": "get-contacts",
      "parameters": {
        "login-token": apiKey,
        "filter-field": "35", // Phone number field ID
        "filter-value": cleanNumber,
        "start-after": "0", // Required parameter
        "page-size": "10" // Limit to 10 results
      }
    }];
    
    console.log("Sending search request to SalesNexus");
    
    // Make the API request
    const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchPayload)
    });
    
    const result = await response.json();
    console.log("Search result from SalesNexus:", JSON.stringify(result));
    
    // Check if we got a valid response with contacts
    if (result && result[0] && result[0].result && result[0].result.success === "true" && result[0].result["contact-list"]) {
      const contactListStr = result[0].result["contact-list"];
      
      // SalesNexus sometimes returns the contact list as a string that needs to be parsed
      let contactList = [];
      
      try {
        // Try to parse as JSON if it's a string
        if (typeof contactListStr === 'string') {
          contactList = JSON.parse(contactListStr);
        } else if (Array.isArray(contactListStr)) {
          // If it's already an array, use it directly
          contactList = contactListStr;
        } else if (typeof contactListStr === 'object') {
          // If it's an object, wrap it in an array
          contactList = [contactListStr];
        }
      } catch (e) {
        console.error("Error parsing contact list:", e);
        return null;
      }
      
      // Check if we found any contacts
      if (contactList && contactList.length > 0) {
        console.log(`Found ${contactList.length} matching contacts`);
        // Return the ID of the first matching contact
        return contactList[0].id;
      }
    }
    
    console.log("No matching contacts found");
    return null;
  } catch (error) {
    console.error("Error searching for contact:", error);
    return null;
  }
}

// Handle OpenPhone recording webhook
async function handleRecording(payload, contactId) {
  try {
    // Extract the recording details from the OpenPhone payload structure
    const callData = payload.data?.object || {};
    const mediaItems = callData.media || [];
    const recordingUrl = mediaItems.length > 0 ? mediaItems[0].url : "No recording URL available";
    
    const callDate = new Date(callData.createdAt || Date.now()).toLocaleString();
    const callDuration = mediaItems.length > 0 && mediaItems[0].duration ? 
      `${Math.round(mediaItems[0].duration / 60)} minutes` : "Unknown duration";
    const callerNumber = callData.from || "Unknown caller";
    const receiverNumber = callData.to || "Unknown receiver";
    const callId = callData.id || "";
    
    // Create the note details with the recording information
    const noteDetails = `
OpenPhone Call Recording - ${callDate}
-------------------------------------
From: ${callerNumber}
To: ${receiverNumber}
Duration: ${callDuration}
Recording: ${recordingUrl}

Direct link to call in OpenPhone: https://app.openphone.com/calls/${callId}
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
    // Extract the summary details from the OpenPhone payload structure
    const summaryData = payload.data?.object || {};
    const summaryPoints = summaryData.summary || [];
    const nextSteps = summaryData.nextSteps || [];
    
    // Format the summary as a string
    let formattedSummary = "No summary available";
    if (summaryPoints.length > 0) {
      formattedSummary = "Summary:\n- " + summaryPoints.join("\n- ");
      
      if (nextSteps.length > 0) {
        formattedSummary += "\n\nNext Steps:\n- " + nextSteps.join("\n- ");
      }
    }
    
    const callDate = new Date(payload.createdAt || Date.now()).toLocaleString();
    const callId = summaryData.callId || "";
    
    // Create the note details with the summary information
    const noteDetails = `
OpenPhone Call Summary - ${callDate}
------------------------------------
${formattedSummary}

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
    // Extract the transcript details from the OpenPhone payload structure
    const transcriptData = payload.data?.object || {};
    const dialogueSegments = transcriptData.dialogue || [];
    
    // Format the transcript
    let formattedTranscript = "No transcript content";
    if (dialogueSegments.length > 0) {
      formattedTranscript = dialogueSegments
        .map(segment => {
          const speaker = segment.identifier || "Speaker";
          return `${speaker}: ${segment.content || ""}`;
        })
        .join("\n");
    }
    
    const callDate = new Date(transcriptData.createdAt || Date.now()).toLocaleString();
    const callId = transcriptData.callId || "";
    
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
    // Use API key directly
    const apiKey = process.env.SALESNEXUS_API_KEY;
    
    // Define the note creation payload
    const notePayload = [{
      "function": "create-note",
      "parameters": {
        "login-token": apiKey,
        "contact-id": contactId,
        "details": details,
        "type": 1  // Using 1 as a default numeric type code
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
