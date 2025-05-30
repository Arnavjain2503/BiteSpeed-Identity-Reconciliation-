"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Explicitly define the handler type, ensure it returns void or Promise<void>
const identifyHandler = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
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
        const matchingContacts = yield prisma.contact.findMany({
            where: {
                OR: [
                    { email: email !== null && email !== void 0 ? email : undefined },
                    { phoneNumber: phoneString !== null && phoneString !== void 0 ? phoneString : undefined },
                ],
                deletedAt: null,
            },
            orderBy: {
                createdAt: 'asc',
            },
        });
        let primaryContact = null;
        let allRelatedContacts = [];
        if (matchingContacts.length === 0) {
            // --- 2. No existing contacts: Create a new primary contact --- 
            const newContact = yield prisma.contact.create({
                data: {
                    email: email,
                    phoneNumber: phoneString,
                    linkPrecedence: client_1.LinkPrecedence.primary,
                },
            });
            primaryContact = newContact;
            allRelatedContacts.push(newContact);
        }
        else {
            // --- 3. Existing contacts found: Identify primary and link/update --- 
            let primaryCandidates = [];
            const linkedIdsToCheck = new Set();
            for (const contact of matchingContacts) {
                if (contact.linkPrecedence === client_1.LinkPrecedence.primary) {
                    primaryCandidates.push(contact);
                }
                else if (contact.linkedId) {
                    linkedIdsToCheck.add(contact.linkedId);
                }
            }
            if (linkedIdsToCheck.size > 0) {
                const primaryContactsOfSecondaries = yield prisma.contact.findMany({
                    where: {
                        id: { in: Array.from(linkedIdsToCheck) },
                        linkPrecedence: client_1.LinkPrecedence.primary, // Ensure we fetch actual primary contacts
                        deletedAt: null,
                    },
                });
                primaryCandidates.push(...primaryContactsOfSecondaries);
            }
            // Deduplicate primary candidates and ensure they are actually primary
            const uniquePrimaryCandidates = Array.from(new Map(primaryCandidates.map(c => [c.id, c])).values())
                .filter(c => c.linkPrecedence === client_1.LinkPrecedence.primary);
            // Sort primary candidates by creation date
            uniquePrimaryCandidates.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
            if (uniquePrimaryCandidates.length === 0) {
                // Only secondaries matched, or their primaries are deleted/not primary anymore.
                // Find the oldest contact among *all* matches.
                matchingContacts.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
                const oldestMatchedContact = matchingContacts[0];
                if (oldestMatchedContact.linkPrecedence === client_1.LinkPrecedence.secondary && oldestMatchedContact.linkedId) {
                    // Find its primary
                    const actualPrimary = yield prisma.contact.findUnique({ where: { id: oldestMatchedContact.linkedId, deletedAt: null } });
                    if (actualPrimary && actualPrimary.linkPrecedence === client_1.LinkPrecedence.primary) {
                        primaryContact = actualPrimary;
                    }
                    else {
                        // Primary link broken or points to another secondary - promote the oldest matched contact
                        primaryContact = yield prisma.contact.update({
                            where: { id: oldestMatchedContact.id },
                            data: { linkPrecedence: client_1.LinkPrecedence.primary, linkedId: null }
                        });
                    }
                }
                else {
                    // Oldest matched is primary, or secondary without a link - treat as primary
                    primaryContact = oldestMatchedContact;
                    if (primaryContact.linkPrecedence === client_1.LinkPrecedence.secondary) {
                        primaryContact = yield prisma.contact.update({
                            where: { id: primaryContact.id },
                            data: { linkPrecedence: client_1.LinkPrecedence.primary, linkedId: null }
                        });
                    }
                }
            }
            else {
                primaryContact = uniquePrimaryCandidates[0]; // Oldest primary candidate is the main primary
            }
            // --- 4. Handle linking multiple primary groups if necessary --- 
            const allMatchedPrimaryIds = new Set();
            // Collect all primary IDs involved, either directly matched or via linked secondaries
            for (const contact of matchingContacts) {
                if (contact.linkPrecedence === client_1.LinkPrecedence.primary) {
                    allMatchedPrimaryIds.add(contact.id);
                }
                else if (contact.linkedId) {
                    // Find the ultimate primary for this secondary
                    let current = contact;
                    while (current && current.linkPrecedence === client_1.LinkPrecedence.secondary && current.linkedId) {
                        current = yield prisma.contact.findUnique({ where: { id: current.linkedId, deletedAt: null } });
                    }
                    if (current && current.linkPrecedence === client_1.LinkPrecedence.primary) {
                        allMatchedPrimaryIds.add(current.id);
                    }
                }
            }
            if (allMatchedPrimaryIds.size > 1) {
                // Fetch the actual primary contact objects to sort by date
                const primaryContactsToSort = yield prisma.contact.findMany({
                    where: {
                        id: { in: Array.from(allMatchedPrimaryIds) },
                        linkPrecedence: client_1.LinkPrecedence.primary, // Ensure we only fetch primaries
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
                            yield prisma.contact.update({
                                where: { id: contactToDemote.id },
                                data: { linkedId: primaryToKeep.id, linkPrecedence: client_1.LinkPrecedence.secondary }
                            });
                            // Update all secondaries linked to the demoted primary
                            yield prisma.contact.updateMany({
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
            allRelatedContacts = yield prisma.contact.findMany({
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
                const newSecondaryContact = yield prisma.contact.create({
                    data: {
                        email: email,
                        phoneNumber: phoneString,
                        linkedId: primaryContact.id,
                        linkPrecedence: client_1.LinkPrecedence.secondary,
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
        allRelatedContacts = yield prisma.contact.findMany({
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
        const emails = new Set();
        const phoneNumbers = new Set();
        const secondaryContactIds = [];
        // Add primary first
        if (primaryContact.email)
            emails.add(primaryContact.email);
        if (primaryContact.phoneNumber)
            phoneNumbers.add(primaryContact.phoneNumber);
        // Add secondaries
        for (const contact of allRelatedContacts) {
            if (contact.id !== primaryContact.id) {
                secondaryContactIds.push(contact.id);
                if (contact.email)
                    emails.add(contact.email);
                if (contact.phoneNumber)
                    phoneNumbers.add(contact.phoneNumber);
            }
        }
        // Ensure primary email/phone are listed first if they exist
        const finalEmails = primaryContact.email ? [primaryContact.email, ...Array.from(emails).filter(e => e !== primaryContact.email)] : Array.from(emails);
        const finalPhoneNumbers = primaryContact.phoneNumber ? [primaryContact.phoneNumber, ...Array.from(phoneNumbers).filter(p => p !== primaryContact.phoneNumber)] : Array.from(phoneNumbers);
        const responsePayload = {
            contact: {
                primaryContatctId: primaryContact.id,
                emails: finalEmails,
                phoneNumbers: finalPhoneNumbers,
                secondaryContactIds: secondaryContactIds.sort((a, b) => a - b), // Sort secondary IDs for consistency
            },
        };
        // Send response without returning it
        res.status(200).json(responsePayload);
        // Implicit return void
    }
    catch (error) {
        console.error('Error processing /identify request:', error);
        // Send response without returning it
        res.status(500).json({ error: 'Internal server error.' });
        // Implicit return void
    }
});
// Register the handler
app.post('/identify', identifyHandler);
// Basic error handler middleware (catches errors from synchronous code or explicitly passed via next() if it were used)
app.use((err, req, res, next) => {
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
