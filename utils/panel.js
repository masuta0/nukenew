// role panel utility for role assignment via buttons

class RolePanel {
    constructor() {
        this.roles = {};
    }

    // Method to assign a role to a user
    assignRole(userId, roleName) {
        if (!this.roles[roleName]) {
            console.error(`Role ${roleName} does not exist!`);
            return;
        }
        this.roles[roleName].push(userId);
        console.log(`Assigned role ${roleName} to user ${userId}.`);
    }

    // Method to remove a role from a user
    removeRole(userId, roleName) {
        if (!this.roles[roleName]) {
            console.error(`Role ${roleName} does not exist!`);
            return;
        }
        this.roles[roleName] = this.roles[roleName].filter(id => id !== userId);
        console.log(`Removed role ${roleName} from user ${userId}.`);
    }

    // Method to add a new role
    addRole(roleName) {
        if (this.roles[roleName]) {
            console.error(`Role ${roleName} already exists!`);
            return;
        }
        this.roles[roleName] = [];
        console.log(`Added new role: ${roleName}.`);
    }

    // Method to get all users with a specific role
    getUsersWithRole(roleName) {
        if (!this.roles[roleName]) {
            console.error(`Role ${roleName} does not exist!`);
            return [];
        }
        return this.roles[roleName];
    }
}

// Export the RolePanel class
module.exports = RolePanel;
