const Settings = {
    containerId: 'settings-container',
    currentCategory: 'Times', // Matches the DB Column Name

    init() {
        const container = document.getElementById(this.containerId);
        // Only render the shell once
        this.renderShell(container);
        this.refreshList();
    },

    renderShell(container) {
        container.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px;">
                <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid var(--neutrals-lightmode-light-mode-Border, #d6d3cb); box-shadow: 0 2px 5px rgba(0,0,0,0.05); grid-column: span 2;">
                    <h3 style="margin-top:0; font-size:16px; color:var(--neutrals-lightmode-light-mode-Textprimary, #141718);">📋 Dropdown Management</h3>
                    
                    <div style="margin-bottom: 15px;">
                        <label style="font-size: 12px; font-weight: bold; display: block; margin-bottom: 5px;">Category:</label>
                        <select id="setting-category-select" onchange="Settings.switchCategory(this.value)" style="width: 100%; padding: 10px; border: 1px solid var(--neutrals-lightmode-light-mode-Borderstrong, #b2aea4); border-radius: 4px; font-size: 14px;">
                            <option value="Times">Times (Col 1)</option>
                            <option value="Places">Places (Col 2)</option>
                            <option value="Activities">Activities (Col 3)</option>
                            <option value="Assets">Assets (Col 4)</option>
                            <option value="Trade_Partners">Trade Partners (Col 6)</option>
                            <option value="Results">Results (Col 7)</option>
                        </select>
                    </div>

                    <div id="items-list-wrapper" style="max-height: 300px; overflow-y: auto; border: 1px solid var(--neutrals-lightmode-light-mode-Subtle, #e7e5df); border-radius: 4px; background: #fafafa;">
                        <div id="dropdown-items-list" style="padding: 10px;"></div>
                    </div>

                    <div style="margin-top: 15px; display: flex; gap: 10px;">
                        <input type="text" id="new-option-input" placeholder="New entry name..." style="flex: 1; padding: 10px; border: 1px solid var(--neutrals-lightmode-light-mode-Border, #d6d3cb); border-radius: 4px;">
                        <button id="add-opt-btn" onclick="Settings.addOption()" style="background: var(--lp-action, #2f7a31); color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">Add</button>
                    </div>
                </div>

                <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid var(--neutrals-lightmode-light-mode-Border, #d6d3cb); box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                    <h3 style="margin-top:0; font-size:16px; color:var(--neutrals-lightmode-light-mode-Textprimary, #141718);">🧹 Maintenance</h3>
                    <button onclick="Settings.cleanup(this)" style="background: #616161; color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; width: 100%; margin-bottom: 10px;">Clear Empty Database Rows</button>
                </div>
            </div>
        `;
        // Ensure the selector matches our internal state
        document.getElementById('setting-category-select').value = this.currentCategory;
    },

    switchCategory(val) {
        this.currentCategory = val;
        this.refreshList();
    },

    async refreshList() {
        const listDiv = document.getElementById('dropdown-items-list');
        if (!listDiv) return;

        // Map UI categories to window.dropdownData keys
        const mapping = { 'Times': 'col1', 'Places': 'col2', 'Activities': 'col3', 'Assets': 'col4', 'Trade_Partners': 'col6', 'Results': 'col7' };
        const dataKey = mapping[this.currentCategory];
        const options = window.dropdownData[dataKey] || [];

        if (options.length === 0) {
            listDiv.innerHTML = '<p style="color:var(--neutrals-lightmode-light-mode-Textsecondary, #6a675f); text-align:center; padding:20px;">No entries found.</p>';
            return;
        }

        listDiv.innerHTML = options.map(opt => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 5px; border-bottom:1px solid var(--neutrals-lightmode-light-mode-Subtle, #e7e5df);">
                <span style="font-size:13px; color:var(--neutrals-lightmode-light-mode-Textprimary, #141718);">${opt}</span>
                <button onclick="Settings.deleteOption('${opt.replace(/'/g, "\\'")}')" style="background:none; border:none; color:#d32f2f; cursor:pointer; font-size:20px; padding:0 5px;">&times;</button>
            </div>
        `).join('');
    },

async addOption() {
        const input = document.getElementById('new-option-input');
        const btn = document.getElementById('add-opt-btn');
        const val = input.value.trim();
        if (!val) return;

        btn.disabled = true;
        btn.innerText = "Saving...";

        try {
            const payload = {};
            payload[this.currentCategory] = val;

            // THE FIX 1: Updated the table name to match your Supabase schema
            const { error } = await _supabase.from('STY4dropdownoptions').insert([payload]);

            if (error) throw error;

            input.value = "";
            
            // THE FIX 2: Call the correct fetch function from your index.html
            if (typeof fetchSTY4dropdownoptions === 'function') {
                await fetchSTY4dropdownoptions(); 
            }
            
            if (typeof refreshDropdowns === 'function') refreshDropdowns(); 
            this.refreshList(); 
            
        } catch (error) {
            console.error("Settings Add Error:", error);
            alert("Error: " + (error.message || "Failed to save option."));
        } finally {
            // THE FIX 3: Placed inside 'finally' so it ALWAYS resets the button
            btn.disabled = false;
            btn.innerText = "Add";
        }
    },

    async deleteOption(val) {
        if (!confirm(`Delete "${val}"?`)) return;
        
        try {
            const update = {};
            update[this.currentCategory] = null;

            const { error } = await _supabase
                .from('STY4dropdownoptions') // Updated table name
                .update(update)
                .eq(this.currentCategory, val);

            if (error) throw error;

            if (typeof fetchSTY4dropdownoptions === 'function') {
                await fetchSTY4dropdownoptions(); // Updated function name
            }
            
            if (typeof refreshDropdowns === 'function') refreshDropdowns();
            this.refreshList();
            
        } catch (error) {
            console.error("Settings Delete Error:", error);
            alert("Error: " + (error.message || "Failed to delete option."));
        }
    },

    async cleanup(btn) {
        btn.disabled = true;
        btn.innerText = "Cleaning...";
        
        try {
            const { error } = await _supabase
                .from('STY4dropdownoptions') // Updated table name
                .delete()
                .is('Times', null).is('Places', null).is('Activities', null)
                .is('Assets', null).is('Trade_Partners', null).is('Results', null);
                
            if (error) throw error;
            alert("Empty rows removed.");
            
        } catch (error) {
            console.error("Settings Cleanup Error:", error);
            alert("Error: " + (error.message || "Cleanup failed."));
        } finally {
            btn.disabled = false;
            btn.innerText = "Clear Empty Database Rows";
        }
    }
};