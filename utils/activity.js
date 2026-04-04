// utils/activity.js

class ActivityTracker {
    constructor() {
        this.activities = [];
    }

    logActivity(activity) {
        const timestamp = new Date();
        this.activities.push({ activity, timestamp });
    }

    getWeeklyActivities() {
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        return this.activities.filter(activity =>
            activity.timestamp >= oneWeekAgo
        );
    }

    getMonthlyActivities() {
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        return this.activities.filter(activity =>
            activity.timestamp >= oneMonthAgo
        );
    }

    clearActivities() {
        this.activities = [];
    }
}

// Export the ActivityTracker class
module.exports = ActivityTracker;