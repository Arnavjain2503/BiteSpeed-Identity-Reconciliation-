import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient, Contact, LinkPrecedence } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
app.use(express.json());

interface IdentifyRequest {
    email?: string;
    phoneNumber?: string; // Keep as string from input, will be string in DB
}

interface IdentifyResponse {
    contact: {
        primaryContatctId: number;
        emails: string[]; // first element being email of primary contact
        phoneNumbers: string[]; // first element being phoneNumber of primary contact
        secondaryContactIds: number[]; // Array of all Contact IDs that are "secondary" to the primary contact
    };
}

// Explicitly define the handler type, ensure it returns void or Promise<void>
const identifyHandler: RequestHandler<{}, IdentifyResponse | { error: string }, IdentifyRequest> = async (req, res) => {
    const { email, phoneNumber } = req.body;

    // Use the phoneNumber as string directly if provided
    const phoneString = phoneNumber ? String(phoneNumber) : undefined;

    if (!email && !phoneString) {
        // Send response without returning it
        res.status(400).json({ error: 'Either email or phoneNumber must be provided.' });
        return; // Explicit return void
    }

    try {
        // --- 1. Find existing contacts by email or phone number --- 
        const matchingContacts = await prisma.contact.findMany({
            where: {
                OR: [
                    { email: email ?? undefined },
                    { phoneNumber: phoneString ?? undefined },
                ],
                deletedAt: null,
            },
            orderBy: {
                createdAt: 'asc',
            },
        });

        let primaryContact: Contact | null = null;
        let allRelatedContacts: Contact[] = [];

        if (matchingContacts.length === 0) {
            // --- 2. No existing contacts: Create a new primary contact --- 
            const newContact = await prisma.contact.create({
                data: {
                    email: email,
                    phoneNumber: phoneString,
                    linkPrecedence: LinkPrecedence.primary,
                },
            });
            primaryContact = newContact;
            allRelatedContacts.push(newContact);
        } else {
            // --- 3. Existing contacts found: Identify primary and link/update --- 
            let primaryCandidates: Contact[] = [];
            const linkedIdsToCheck = new Set<number>();

            for (const contact of matchingContacts) {
                if (contact.linkPrecedence === LinkPrecedence.primary) {
                    primaryCandidates.push(contact);
                } else if (contact.linkedId) {
                    linkedIdsToCheck.add(contact.linkedId);
                }
            }

            if (linkedIdsToCheck.size > 0) {
                const primaryContactsOfSecondaries = await prisma.contact.findMany({
                    where: {
                        id: { in: Array.from(linkedIdsToCheck) },
                        linkPrecedence: LinkPrecedence.primary, // Ensure we fetch actual primary contacts
                        deletedAt: null,
                    },
                });
                primaryCandidates.push(...primaryContactsOfSecondaries);
            }

            // Deduplicate primary candidates and ensure they are actually primary
            const uniquePrimaryCandidates = Array.from(new Map(primaryCandidates.map(c => [c.id, c])).values())
                                              .filter(c => c.linkPrecedence === LinkPrecedence.primary);
            
            // Sort primary candidates by creation date
            uniquePrimaryCandidates.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

            if (uniquePrimaryCandidates.length === 0) {
                 // Only secondaries matched, or their primaries are deleted/not primary anymore.
                 // Find the oldest contact among *all* matches.
                 matchingContacts.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
                 const oldestMatchedContact = matchingContacts[0];

                 if (oldestMatchedContact.linkPrecedence === LinkPrecedence.secondary && oldestMatchedContact.linkedId) {
                     // Find its primary
                     const actualPrimary = await prisma.contact.findUnique({ where: { id: oldestMatchedContact.linkedId, deletedAt: null } });
                     if (actualPrimary && actualPrimary.linkPrecedence === LinkPrecedence.primary) {
                         primaryContact = actualPrimary;
                     } else {
                         // Primary link broken or points to another secondary - promote the oldest matched contact
                         primaryContact = await prisma.contact.update({ 
                             where: { id: oldestMatchedContact.id }, 
                             data: { linkPrecedence: LinkPrecedence.primary, linkedId: null }
                         });
                     }
                 } else {
                     // Oldest matched is primary, or secondary without a link - treat as primary
                     primaryContact = oldestMatchedContact;
                     if (primaryContact.linkPrecedence === LinkPrecedence.secondary) {
                         primaryContact = await prisma.contact.update({ 
                             where: { id: primaryContact.id }, 
                             data: { linkPrecedence: LinkPrecedence.primary, linkedId: null }
                         });
                     }
                 }
            } else {
                 primaryContact = uniquePrimaryCandidates[0]; // Oldest primary candidate is the main primary
            }

            // --- 4. Handle linking multiple primary groups if necessary --- 
            const allMatchedPrimaryIds = new Set<number>();
            // Collect all primary IDs involved, either directly matched or via linked secondaries
            for (const contact of matchingContacts) {
                if (contact.linkPrecedence === LinkPrecedence.primary) {
                    allMatchedPrimaryIds.add(contact.id);
                } else if (contact.linkedId) {
                    // Find the ultimate primary for this secondary
                    let current: Contact | null = contact;
                    while (current && current.linkPrecedence === LinkPrecedence.secondary && current.linkedId) {
                        current = await prisma.contact.findUnique({ where: { id: current.linkedId, deletedAt: null } });
                    }
                    if (current && current.linkPrecedence === LinkPrecedence.primary) {
                        allMatchedPrimaryIds.add(current.id);
                    }
                }
            }

            if (allMatchedPrimaryIds.size > 1) {
                // Fetch the actual primary contact objects to sort by date
                const primaryContactsToSort = await prisma.contact.findMany({
                    where: { 
                        id: { in: Array.from(allMatchedPrimaryIds) },
                        linkPrecedence: LinkPrecedence.primary, // Ensure we only fetch primaries
                        deletedAt: null 
                    }
                });
                
                // Sort the fetched primary contacts by creation date
                primaryContactsToSort.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

                if (primaryContactsToSort.length > 0) {
                    const primaryToKeep = primaryContactsToSort[0];
                    primaryContact = primaryToKeep; // Update our main primaryContact reference
                    const primariesToDemote = primaryContactsToSort.slice(1);

                    for (const contactToDemote of primariesToDemote) {
                        if (contactToDemote.id !== primaryToKeep.id) { // Avoid self-linking
                            // Update the demoted primary itself
                            await prisma.contact.update({ 
                                where: { id: contactToDemote.id }, 
                                data: { linkedId: primaryToKeep.id, linkPrecedence: LinkPrecedence.secondary }
                            });
                            // Update all secondaries linked to the demoted primary
                            await prisma.contact.updateMany({ 
                                where: { linkedId: contactToDemote.id }, 
                                data: { linkedId: primaryToKeep.id }
                            });
                        }
                    }
                }
            }

            // --- 5. Fetch all contacts related to the final primary contact --- 
            // Ensure primaryContact is not null before proceeding
            if (!primaryContact) {
                 // This should ideally not happen, but throw an error if it does
                 console.error("Critical Error: Primary contact is null before fetching related contacts.");
                 throw new Error("Failed to determine primary contact after linking logic.");
            }
            allRelatedContacts = await prisma.contact.findMany({
                where: {
                    OR: [
                        { id: primaryContact.id },
                        { linkedId: primaryContact.id },
                    ],
                    deletedAt: null,
                },
                orderBy: {
                    createdAt: 'asc',
                },
            });

            // --- 6. Check if a new secondary contact needs to be created --- 
            const currentEmails = new Set(allRelatedContacts.map(c => c.email).filter(Boolean));
            const currentPhones = new Set(allRelatedContacts.map(c => c.phoneNumber).filter(Boolean));

            const needsNewSecondary = (email && !currentEmails.has(email)) || (phoneString && !currentPhones.has(phoneString));
            
            if (needsNewSecondary) {
                const newSecondaryContact = await prisma.contact.create({
                    data: {
                        email: email,
                        phoneNumber: phoneString,
                        linkedId: primaryContact.id,
                        linkPrecedence: LinkPrecedence.secondary,
                    },
                });
                allRelatedContacts.push(newSecondaryContact); // Add to the list for response consolidation
            }
        }

        // --- 7. Consolidate information for the response --- 
        if (!primaryContact) {
            // This should not happen with the logic above, but handle defensively
            console.error("Error: Primary contact became null before response generation.");
            res.status(500).json({ error: 'Could not determine primary contact.' });
            return; // Explicit return void
        }

        // Re-fetch final set of related contacts to ensure accuracy after all updates
         allRelatedContacts = await prisma.contact.findMany({
            where: {
                OR: [
                    { id: primaryContact.id },
                    { linkedId: primaryContact.id },
                ],
                deletedAt: null,
            },
            orderBy: {
                createdAt: 'asc',
            },
        });

        const emails = new Set<string>();
        const phoneNumbers = new Set<string>();
        const secondaryContactIds: number[] = [];

        // Add primary first
        if (primaryContact.email) emails.add(primaryContact.email);
        if (primaryContact.phoneNumber) phoneNumbers.add(primaryContact.phoneNumber);

        // Add secondaries
        for (const contact of allRelatedContacts) {
            if (contact.id !== primaryContact.id) {
                secondaryContactIds.push(contact.id);
                if (contact.email) emails.add(contact.email);
                if (contact.phoneNumber) phoneNumbers.add(contact.phoneNumber);
            }
        }
        // Ensure primary email/phone are listed first if they exist
        const finalEmails = primaryContact.email ? [primaryContact.email, ...Array.from(emails).filter(e => e !== primaryContact!.email)] : Array.from(emails);
        const finalPhoneNumbers = primaryContact.phoneNumber ? [primaryContact.phoneNumber, ...Array.from(phoneNumbers).filter(p => p !== primaryContact!.phoneNumber)] : Array.from(phoneNumbers);

        const responsePayload: IdentifyResponse = {
            contact: {
                primaryContatctId: primaryContact.id,
                emails: finalEmails,
                phoneNumbers: finalPhoneNumbers,
                secondaryContactIds: secondaryContactIds.sort((a,b) => a - b), // Sort secondary IDs for consistency
            },
        };
        // Send response without returning it
        res.status(200).json(responsePayload);
        // Implicit return void

    } catch (error) {
        console.error('Error processing /identify request:', error);
        // Send response without returning it
        res.status(500).json({ error: 'Internal server error.' });
        // Implicit return void
    }
};

// Register the handler
app.post('/identify', identifyHandler);


// Basic error handler middleware (catches errors from synchronous code or explicitly passed via next() if it were used)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(err.stack);
    // Avoid sending response if headers already sent (e.g., by the route handler itself)
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// Ensure PORT is a number
const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
