// Ticket System Utility for Support Ticket Management

class Ticket {
    constructor(id, user, title, description) {
        this.id = id;
        this.user = user;
        this.title = title;
        this.description = description;
        this.status = 'open'; // open, in-progress, closed
        this.createdAt = new Date();
        this.updatedAt = new Date();
    }

    updateStatus(newStatus) {
        this.status = newStatus;
        this.updatedAt = new Date();
    }

    toString() {
        return `Ticket ID: ${this.id}\nUser: ${this.user}\nTitle: ${this.title}\nDescription: ${this.description}\nStatus: ${this.status}\nCreated At: ${this.createdAt.toISOString()}\nUpdated At: ${this.updatedAt.toISOString()}`;
    }
}

class TicketSystem {
    constructor() {
        this.tickets = [];
        this.currentId = 1;
    }

    createTicket(user, title, description) {
        const ticket = new Ticket(this.currentId++, user, title, description);
        this.tickets.push(ticket);
        return ticket;
    }

    getTicket(id) {
        return this.tickets.find(ticket => ticket.id === id);
    }

    updateTicket(id, newStatus) {
        const ticket = this.getTicket(id);
        if (ticket) {
            ticket.updateStatus(newStatus);
            return ticket;
        }
        return null;
    }

    listTickets() {
        return this.tickets;
    }
}

// Example Usage
// const ticketSystem = new TicketSystem();
// const newTicket = ticketSystem.createTicket('user1', 'Issue with login', 'User is unable to log into the system.');
// console.log(newTicket.toString());

