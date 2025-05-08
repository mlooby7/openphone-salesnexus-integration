// functions/webhook.js

// Import node-fetch if not available in environment
let fetch;
try {
  fetch = require('node-fetch');
} catch (e) {
  // fetch is already available in the environment
}

exports.handler = async function(event, context) {
  try {
    // Parse the webhook payload from OpenPhone
    const payload = JSON.parse(event.body);
    console.log("Received webhook from OpenPhone:", JSON.stringify(payload));

    // Extract call ID and store it for consistent handling across webhooks
    let callId = "";
    
    // The structure of the payload differs by webhook type
    if (payload.type && payload.type.includes("recording")) {
      // Recording webhooks have the call details directly in data.object
      if (payload.data && payload.data.object) {
        callId = payload.data.object.id || "";
      }
    } else if (payload.type && (payload.type.includes("transcript") || payload.type.includes("summary"))) {
      // Transcript and summary webhooks have the callId in data.object.callId
      if (payload.data && payload.data.object) {
        callId = payload.data.object.callId || "";
      }
    }
    
    // Extract phone numbers from the webhook (for recording events)
    // For transcript and summary events, we'll use stored data
    let phoneNumbers = { from: "", to: "" };
    
    if (payload.type && payload.type.includes("recording") && payload.data && payload.data.object) {
      phoneNumbers.from = payload.data.object.from || "";
      phoneNumbers.to = payload.data.object.to || "";
      
      // Store these details for later use with transcript and summary events
      callDetailsStore[callId] = phoneNumbers;
    } else {
      // Try to retrieve stored phone numbers for this call
      if (callId && callDetailsStore[callId]) {
        phoneNumbers = callDetailsStore[callId];
      }
    }
    
    console.log(`Processing call ID: ${callId}`);
    console.log(`Phone numbers - From: ${phoneNumbers.from}, To: ${phoneNumbers.to}`);
    
    // Determine which phone number to use for contact matching
    // For outgoing calls (from your OpenPhone number), use the "to" number
    // For incoming calls (to your OpenPhone number), use the "from" number
    const direction = payload.data?.object?.direction || "outgoing";
    const lookupNumber = direction === "outgoing" ? phoneNumbers.to : phoneNumbers.from;
    
    console.log(`Using ${lookupNumber} to look up contact`);
    
    // Default to fallback contact ID
    let contactId = process.env.FALLBACK_CONTACT_ID;
    
    // Try to look up email based on phone number
    if (lookupNumber) {
      try {
        // Normalize the phone number to E.164 format
        const formattedPhone = formatPhoneNumber(lookupNumber);
        console.log(`Looking up contact for normalized phone: ${formattedPhone}`);
        
        // We'll directly search for contacts in SalesNexus by phone substring
        // Since SalesNexus API doesn't support direct phone number search, 
        // we'll try to find matches by searching for the phone digits
        
        // Extract just the digits for fuzzy matching
        const phoneDigits = formattedPhone.replace(/\D/g, '').slice(-10); // Last 10 digits
        if (phoneDigits.length >= 7) { // Only search if we have enough digits
          console.log(`Searching for contacts with phone digits: ${phoneDigits}`);
          
          // Search for contacts in SalesNexus using these digits
          const matchingContactId = await searchContactsByPhoneDigits(phoneDigits);
          
          if (matchingContactId) {
            contactId = matchingContactId;
            console.log(`Found matching contact by phone digits: ${contactId}`);
          } else {
            console.log(`No matching contact found by phone digits, using fallback: ${contactId}`);
          }
        }
      } catch (error) {
        console.error("Error looking up contact:", error);
        console.log(`Using fallback contact ID: ${contactId}`);
      }
    } else {
      console.log("No phone number to look up, using fallback contact");
    }
    
    // Handle different webhook event types from OpenPhone
    const webhookType = payload.type || "";
    
    if (webhookType.includes("recording")) {
      await handleRecording(payload, contactId);
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

// Format phone number to E.164 format
function formatPhoneNumber(phone) {
  if (!phone) return "";
  
  // Remove all non-digit characters
  let digits = phone.replace(/\D/g, '');
  
  // Add country code if missing
  if (digits.length === 10) {
    digits = '1' + digits; // Assume US number
  }
  
  // Return formatted number
  return '+' + digits;
}

// Search for contacts in SalesNexus that might have this phone number
async function searchContactsByPhoneDigits(phoneDigits) {
  try {
    // Get the API key
    const apiKey = process.env.SALESNEXUS_API_KEY;
    
    // Get a batch of contacts to search through
    // We'll search through them client-side since the API doesn't support direct phone search
    const getContactsPayload = [{
      "function": "get-contacts",
      "parameters": {
        "login-token": apiKey,
        "start-after": "0",
        "page-size": "100" // Get a reasonable batch size
      }
    }];
    
    // Make the API request
    const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getContactsPayload)
    });
    
    const result = await response.json();
    
    // Check if we got a valid response with contacts
    if (result && result[0].result && result[0].result.success === "true" && result[0].result["contact-list"]) {
      let contacts = [];
      
      // Parse the contact list
      try {
        const contactListStr = result[0].result["contact-list"];
        
        if (typeof contactListStr === 'string') {
          contacts = JSON.parse(contactListStr);
        } else if (Array.isArray(contactListStr)) {
          contacts = contactListStr;
        } else if (typeof contactListStr === 'object') {
          contacts = [contactListStr];
        }
      } catch (e) {
        console.error("Error parsing contact list:", e);
        return null;
      }
      
      console.log(`Searching through ${contacts.length} contacts for phone match`);
      
      // For each contact, look for any fields that might contain this phone number
      for (const contact of contacts) {
        // Get the complete contact info to check all fields
        const contactId = contact.id;
        const contactFields = await getContactFields(contactId);
        
        if (contactFields) {
          // Check each field for a phone number match
          for (const [fieldId, fieldValue] of Object.entries(contactFields)) {
            if (typeof fieldValue === 'string') {
              // Extract digits only from the field value
              const fieldDigits = fieldValue.replace(/\D/g, '');
              
              // Check if this field contains our phone digits
              if (fieldDigits.includes(phoneDigits) || phoneDigits.includes(fieldDigits)) {
                console.log(`Found match in contact ${contactId}, field ${fieldId}: ${fieldValue}`);
                return contactId;
              }
            }
          }
        }
      }
      
      console.log("No matching contact found after checking all contacts");
    } else {
      console.log("No contacts returned from API or error in response");
    }
    
    return null;
  } catch (error) {
    console.error("Error searching for contacts:", error);
    return null;
  }
}

// Get all field values for a specific contact
async function getContactFields(contactId) {
  try {
    // Get the API key
    const apiKey = process.env.SALESNEXUS_API_KEY;
    
    // Use the API to get contact info
    const getContactInfoPayload = [{
      "function": "get-contact-info",
      "parameters": {
        "login-token": apiKey,
        "contact-id": contactId
      }
    }];
    
    // Make the API request
    const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getContactInfoPayload)
    });
    
    const result = await response.json();
    
    // Check for valid response
    if (result && result[0].result && result[0].result.success === "true" && result[0].result["field-data"]) {
      try {
        const fieldDataStr = result[0].result["field-data"];
        return typeof fieldDataStr === 'string' ? JSON.parse(fieldDataStr) : fieldDataStr;
      } catch (e) {
        console.error("Error parsing field data:", e);
      }
    }
    
    return null;
  } catch (error) {
    console.error("Error getting contact fields:", error);
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
