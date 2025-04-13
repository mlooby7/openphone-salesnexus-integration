// functions/webhook.js
const axios = require('axios');

exports.handler = async function(event, context) {
  console.log('Webhook function invoked');
  
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    console.log('Received non-POST request, returning 405');
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse the OpenPhone webhook payload
    const payload = JSON.parse(event.body);
    console.log('Received webhook from OpenPhone:', payload);
    
    // Get event type
    const eventType = payload.type;
    console.log('Event type:', eventType);
    
    // Different handling based on event type
    let phoneNumber, callId, noteType, noteDetails;
    
    if (eventType === 'call.recording.completed') {
      // Handle call recordings
      const callData = payload.data.object;
      // For outgoing calls, use the "to" number (recipient)
      // For incoming calls, use the "from" number (caller)
      phoneNumber = callData.direction === 'incoming' ? callData.from : callData.to;
      callId = callData.id;
      
      // Extract the media details
      const mediaUrl = callData.media && callData.media[0] && callData.media[0].url 
        ? callData.media[0].url 
        : "No recording URL available";
      const mediaDuration = callData.media && callData.media[0] && callData.media[0].duration 
        ? callData.media[0].duration 
        : 0;
      
      noteType = "Recording";
      noteDetails = `Call Recording from ${phoneNumber}\n\n` +
                   `Date/Time: ${new Date(callData.createdAt).toLocaleString()}\n` +
                   `Direction: ${callData.direction === 'incoming' ? 'Inbound' : 'Outbound'}\n` +
                   `Duration: ${mediaDuration} seconds\n\n` +
                   `Recording URL: ${mediaUrl}\n\n` +
                   `OpenPhone Links:\n` +
                   `- Contact: https://app.openphone.com/contacts/${phoneNumber}\n` +
                   `- Call: https://app.openphone.com/calls/${callId}`;
    }
    else if (eventType === 'call.summary.completed') {
      // Handle call summaries
      const summaryData = payload.data.object;
      callId = summaryData.callId;
      
      // For summaries, we need to figure out which phone number to use
      // Since callId is the same for all three events, we can use it to look up the right contact
      phoneNumber = process.env.DEFAULT_DESTINATION || '+18884640727';
      
      // Extract actual summary content
      let summaryText = '';
      if (summaryData.summary && Array.isArray(summaryData.summary)) {
        summaryText = summaryData.summary.map(item => `• ${item}`).join('\n');
      } else if (typeof summaryData.summary === 'string') {
        summaryText = summaryData.summary;
      }
      
      noteType = "Summary";
      noteDetails = `Call Summary\n\n` +
                   `Call ID: ${callId}\n\n` +
                   `Summary:\n${summaryText}\n\n` +
                   `OpenPhone Links:\n` +
                   `- Call: https://app.openphone.com/calls/${callId}`;
    }
    else if (eventType === 'call.transcript.completed') {
      // Handle call transcripts
      const transcriptData = payload.data.object;
      callId = transcriptData.callId;
      
      // For transcripts, we also use the same approach as summaries
      phoneNumber = process.env.DEFAULT_DESTINATION || '+18884640727';
      
      // Extract actual transcript content
      let transcriptText = '';
      if (transcriptData.dialogue && Array.isArray(transcriptData.dialogue)) {
        transcriptText = transcriptData.dialogue
          .filter(d => d && d.text && d.speaker) // Filter out undefined entries
          .map(d => `${d.speaker || 'Speaker'}: ${d.text || ''}`)
          .join('\n');
      }
      
      if (!transcriptText) {
        transcriptText = "Transcript unavailable. Please view in OpenPhone.";
      }
      
      noteType = "Transcript";
      noteDetails = `Call Transcript\n\n` +
                   `Call ID: ${callId}\n` +
                   `Duration: ${transcriptData.duration || 0} seconds\n\n` +
                   `Transcript:\n${transcriptText}\n\n` +
                   `OpenPhone Links:\n` +
                   `- Call: https://app.openphone.com/calls/${callId}`;
    }
    else {
      console.log('Unsupported event type:', eventType);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Unsupported event type" })
      };
    }
    
    console.log(`Original phone: ${phoneNumber}`);
    
    // Use SalesNexus API key as login token
    const apiKey = process.env.SALESNEXUS_API_KEY;
    if (!apiKey) {
      throw new Error('SALESNEXUS_API_KEY environment variable is not set');
    }
    console.log('API Key is set');
    
    // Map of phone numbers to SalesNexus contact IDs
    const phoneToContactMap = {
      '+18884640727': 'cea99ef5-c1e1-4ad5-a73a-bd74144e71a6', // Capital One
      '+18882134286': '91ec6856-63b1-4f7f-9a16-deac42371d14'  // Amex
    };
    
    // Determine which contact ID to use
    let contactId = null;
    
    if (phoneNumber && phoneToContactMap[phoneNumber]) {
      contactId = phoneToContactMap[phoneNumber];
      console.log(`Found contact ID ${contactId} for phone number ${phoneNumber}`);
    } else {
      // Use fallback if no mapping exists
      contactId = process.env.FALLBACK_CONTACT_ID;
      console.log(`No contact mapping found for ${phoneNumber}. Using fallback: ${contactId}`);
    }
    
    // Create note in SalesNexus
    console.log('Creating note in SalesNexus for contact ID:', contactId);
    try {
      const noteResponse = await axios.post('https://logon.salesnexus.com/api/call-v1', [{
        "function": "create-note",
        "parameters": {
          "login-token": apiKey,
          "contact-id": contactId,
          "details": noteDetails,
          "type": "1"
        }
      }]);
      
      console.log('Note creation response:', noteResponse.data);
    } catch (noteError) {
      console.error('Error creating note:', noteError.message);
      if (noteError.response) {
        console.error('Response data:', noteError.response.data);
      }
      throw noteError;
    }
    
    // Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Successfully processed OpenPhone webhook",
        contactId: contactId,
        noteType: noteType
      })
    };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: "Error processing webhook",
        details: error.message
      })
    };
  }
};
